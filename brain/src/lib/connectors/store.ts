import { z } from "zod";
import type { KV } from "../kv";
import { decrypt, encrypt, randomToken } from "../crypto";
import { CAPABILITY_IDS, type CapabilityId } from "./capabilities";
import type { Connector } from "./types";

/**
 * Encrypted, per-connector credential store (docs/CONNECTORS.md §7). Generalises the old
 * `GoogleTokenStore`, which is now a thin adapter over this class.
 *
 *  - Redis key `${prefix}:conn:<connectorId>:tokens`, AES-256-GCM with TOKEN_ENCRYPTION_KEY and
 *    AAD `sidekiqq:conn:<connectorId>:v1`, so a ciphertext can't be replayed under another connector.
 *  - Key rotation: if TOKEN_ENCRYPTION_KEY_PREV is set, it is tried on decrypt, and a successful
 *    read with it re-encrypts the record with the current key.
 *  - Google migration (§8 step 3): the legacy `${prefix}:google:tokens` record is copied to the
 *    new key on first load. The legacy key is kept (read-only) for one release.
 *  - Per-connection enabled capabilities and status (`connected` / `needs_reauth`).
 *  - OAuth `state` (single use, 10 min) carries the PKCE code verifier; connect tickets are single
 *    use, 5 min. Both are namespaced per connector.
 *
 * Access tokens are never stored here: they are minted on demand and cached in memory only.
 */

export interface KeyRing {
  current: Buffer;
  /** The previous TOKEN_ENCRYPTION_KEY during a rotation. Decrypt-only. */
  previous?: Buffer;
}

const ConnectorIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "invalid connector id");

const isCap = (s: unknown): s is CapabilityId => typeof s === "string" && (CAPABILITY_IDS as string[]).includes(s);
/** Lenient: an id removed or renamed in a later release is dropped, not a reason to lose the whole record. */
const EnabledSchema = z.array(z.unknown()).transform((a): CapabilityId[] => a.filter(isCap));

export const StoredConnectionSchema = z.object({
  /** OAuth refresh token, or an app-specific password for IMAP/SMTP connectors. Never logged. */
  secret: z.string().min(1),
  secretKind: z.enum(["refresh_token", "app_password"]),
  /** Account label shown to the owner (usually an email address). */
  account: z.string().optional(),
  /** Scopes the provider actually granted. Empty = unknown (e.g. a legacy record without `scope`). */
  grantedScopes: z.array(z.string()),
  connectedAt: z.string(),
  /** Capabilities the owner turned on. Absent = every capability the connector offers. */
  enabled: EnabledSchema.optional(),
  status: z.enum(["connected", "needs_reauth"]).default("connected"),
  lastError: z.string().max(300).optional(),
});
export type StoredConnection = z.infer<typeof StoredConnectionSchema>;
export type StoredConnectionInput = z.input<typeof StoredConnectionSchema>;

/** The pre-framework Google record and its AAD (lib/google/auth.ts before slice 2). */
const LEGACY_GOOGLE_AAD = "sidekiqq:google-refresh-token:v1";
const LegacyGoogleSchema = z.object({
  refreshToken: z.string().min(1),
  email: z.string().optional(),
  scope: z.string().optional(),
  connectedAt: z.string(),
});

export function connectionAad(connectorId: string): string {
  return `sidekiqq:conn:${connectorId}:v1`;
}

/** Splits an OAuth `scope` response (space separated) into a de-duplicated list. */
export function parseScopes(scope: string | undefined | null): string[] {
  return [...new Set((scope ?? "").split(/\s+/).filter(Boolean))];
}

const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export class ConnectionStore {
  constructor(
    private readonly kv: KV,
    private readonly prefix: string,
    private readonly keys: () => KeyRing,
  ) {}

  private tokenKey(connectorId: string) {
    return `${this.prefix}:conn:${ConnectorIdSchema.parse(connectorId)}:tokens`;
  }

  private legacyGoogleKey() {
    return `${this.prefix}:google:tokens`;
  }

  /** Decrypts with the current key, then the previous one. `rotated` = it needed the previous key. */
  private open(payload: string, aad: string): { plain: string; rotated: boolean } {
    const ring = this.keys();
    try {
      return { plain: decrypt(payload, ring.current, aad), rotated: false };
    } catch (err) {
      if (!ring.previous) throw err;
      return { plain: decrypt(payload, ring.previous, aad), rotated: true };
    }
  }

  private seal(connectorId: string, v: StoredConnection): string {
    return encrypt(JSON.stringify(v), this.keys().current, connectionAad(connectorId));
  }

  async save(connectorId: string, v: StoredConnectionInput): Promise<StoredConnection> {
    const parsed = StoredConnectionSchema.parse(v);
    await this.kv.set(this.tokenKey(connectorId), this.seal(connectorId, parsed));
    return parsed;
  }

  /** The stored connection, or null when not connected (or unreadable: the owner must reconnect). */
  async load(connectorId: string): Promise<StoredConnection | null> {
    const key = this.tokenKey(connectorId);
    const raw = await this.kv.get(key);
    if (!raw) return connectorId === "google" ? this.migrateLegacyGoogle() : null;
    let opened: { plain: string; rotated: boolean };
    try {
      opened = this.open(raw, connectionAad(connectorId));
    } catch (err) {
      console.error(`[connections] ${connectorId}: stored credentials could not be decrypted (wrong key or AAD); reconnect required`, (err as Error)?.message);
      return null;
    }
    let stored: StoredConnection;
    try {
      stored = StoredConnectionSchema.parse(JSON.parse(opened.plain));
    } catch (err) {
      console.error(`[connections] ${connectorId}: stored record decrypted but is not valid; reconnect required`, (err as Error)?.message);
      return null;
    }
    if (opened.rotated) {
      // Best effort and not atomic: re-read first so a save that landed since our read is not
      // overwritten with older contents. A write in the remaining gap is overwritten with this
      // (still valid, just older) record; the next load reads it fine.
      try {
        if ((await this.kv.get(key)) === raw) await this.kv.set(key, this.seal(connectorId, stored));
      } catch (err) {
        console.warn(`[connections] ${connectorId}: re-encrypt after key rotation failed`, err);
      }
    }
    return stored;
  }

  /** §8 step 3. Runs only when the new record is missing. Never deletes the legacy record. */
  private async migrateLegacyGoogle(): Promise<StoredConnection | null> {
    const raw = await this.kv.get(this.legacyGoogleKey());
    if (!raw) return null;
    let legacy: z.infer<typeof LegacyGoogleSchema>;
    try {
      legacy = LegacyGoogleSchema.parse(JSON.parse(this.open(raw, LEGACY_GOOGLE_AAD).plain));
    } catch (err) {
      console.error("[connections] google: legacy token could not be decrypted; reconnect required", (err as Error)?.message);
      return null;
    }
    const migrated = StoredConnectionSchema.parse({
      secret: legacy.refreshToken,
      secretKind: "refresh_token",
      ...(legacy.email ? { account: legacy.email } : {}),
      grantedScopes: parseScopes(legacy.scope),
      connectedAt: legacy.connectedAt,
    });
    // A disconnect (clear) may have removed the legacy record since we read it: don't resurrect it.
    if ((await this.kv.get(this.legacyGoogleKey())) === null) return null;
    // nx: if a concurrent request (or a fresh connect) wrote the new record first, keep theirs.
    const wrote = await this.kv.set(this.tokenKey("google"), this.seal("google", migrated), { nx: true });
    if (!wrote) {
      const raw2 = await this.kv.get(this.tokenKey("google"));
      if (raw2) return this.load("google");
    }
    return migrated;
  }

  /**
   * Deletes the stored credentials (and, for Google, the legacy record, so it can't be re-migrated).
   * Revoking at the provider is the caller's job (disconnect route, slice 4).
   */
  async clear(connectorId: string): Promise<void> {
    // Legacy first: a load() between the two deletes must not find it and migrate it back.
    if (connectorId === "google") await this.kv.del(this.legacyGoogleKey());
    await this.kv.del(this.tokenKey(connectorId));
  }

  /** Read-modify-write of one connection. No-op (returns null) when not connected. */
  async update(connectorId: string, patch: (v: StoredConnection) => StoredConnection): Promise<StoredConnection | null> {
    const cur = await this.load(connectorId);
    if (!cur) return null;
    return this.save(connectorId, patch(cur));
  }

  /**
   * Marks the connection as needing reconnect. Returns true only on the transition (so callers
   * alert once). `failedSecret` is the credential the failing call used: if the owner has
   * reconnected since, the new connection is left alone.
   */
  async markNeedsReauth(connectorId: string, reason: string, failedSecret?: string): Promise<boolean> {
    const cur = await this.load(connectorId);
    if (!cur || cur.status === "needs_reauth") return false;
    if (failedSecret !== undefined && cur.secret !== failedSecret) return false;
    await this.save(connectorId, { ...cur, status: "needs_reauth", lastError: reason.slice(0, 300) });
    return true;
  }

  /**
   * Sets the owner's enabled capabilities. Unknown or unsupported ids are rejected so the stored
   * list only ever names capabilities the connector actually offers.
   */
  async setEnabled(connector: Pick<Connector, "id" | "capabilities">, enabled: readonly CapabilityId[]): Promise<StoredConnection | null> {
    const bad = enabled.filter((c) => !connector.capabilities.includes(c));
    if (bad.length) throw new Error(`${connector.id} does not offer ${bad.join(", ")}`);
    return this.update(connector.id, (v) => ({ ...v, enabled: [...new Set(enabled)] }));
  }

  // --- OAuth helpers -------------------------------------------------------------------

  /** OAuth `state` nonce bound to a PKCE code verifier: single use, 10-minute TTL. */
  async issueState(connectorId: string, codeVerifier: string): Promise<string> {
    const state = randomToken(24);
    await this.kv.set(`${this.prefix}:conn:${ConnectorIdSchema.parse(connectorId)}:state:${state}`, codeVerifier, { exSeconds: 600 });
    return state;
  }

  /** Returns the PKCE code verifier for a valid, unused `state`, else null. */
  async consumeState(connectorId: string, state: string): Promise<string | null> {
    if (!NONCE_RE.test(state)) return null;
    return this.kv.getdel(`${this.prefix}:conn:${ConnectorIdSchema.parse(connectorId)}:state:${state}`);
  }

  /** Single-use browser ticket so the owner secret never appears in a URL. */
  async issueConnectTicket(connectorId: string, ttlSeconds = 300): Promise<string> {
    const ticket = randomToken(24);
    await this.kv.set(`${this.prefix}:conn:${ConnectorIdSchema.parse(connectorId)}:ticket:${ticket}`, "1", { exSeconds: ttlSeconds });
    return ticket;
  }

  async consumeConnectTicket(connectorId: string, ticket: string): Promise<boolean> {
    if (!NONCE_RE.test(ticket)) return false;
    return (await this.kv.getdel(`${this.prefix}:conn:${ConnectorIdSchema.parse(connectorId)}:ticket:${ticket}`)) !== null;
  }
}

/**
 * Capabilities that may run on this connection: the owner's enabled list (default: all the
 * connector offers), minus any whose scopes the provider did not grant. When the granted scopes
 * are unknown (legacy record without `scope`), nothing is removed for scope reasons.
 */
export function effectiveCapabilities(connector: Pick<Connector, "capabilities" | "scopesFor">, stored: StoredConnection): CapabilityId[] {
  const wanted = stored.enabled ?? [...connector.capabilities];
  const granted = new Set(stored.grantedScopes);
  return connector.capabilities.filter(
    (c) => wanted.includes(c) && (granted.size === 0 || connector.scopesFor([c]).every((s) => granted.has(s))),
  );
}
