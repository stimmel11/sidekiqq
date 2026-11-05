import { randomToken } from "../../crypto";
import { optional } from "../../env";
import type { KV } from "../../kv";
import { parseScopes, type ConnectionStore, type StoredConnection } from "../store";
import { CapabilityDeniedError, ReauthRequiredError } from "../types";

/**
 * Zoom OAuth for the `zoom` connector (docs/CONNECTORS.md §7). User-managed "General" OAuth app,
 * one granular scope (`meeting:write:meeting`), PKCE on the authorize step.
 *
 * The refresh token is stored by `ConnectionStore` under connector id "zoom" (AAD-bound). Zoom
 * issues a NEW refresh token on every refresh and the used one stops working, so:
 *  - refreshes are serialised across serverless instances with a short KV lock (`RefreshLock`),
 *    and each one reads the latest stored token after taking the lock;
 *  - the rotated token is written back (with retries) before the access token is used; if every
 *    write fails it is kept in memory and used for the next refresh instead of the dead stored one;
 *  - a cached access token stays valid across other instances' rotations; only a reconnect
 *    (a new `connectedAt`) invalidates it.
 * Access tokens live in memory only.
 *
 * This module only signs in and mints tokens. It cannot create meetings (./meetings.ts) and
 * nothing in it can send anything.
 *
 * Slice 1 ships the helpers; the connect/callback routes come with the generic
 * `/api/connections/:id/*` routes (an `OAuthFlow` wrapper around `authorizeUrl` + `exchangeCode`).
 */

export const ZOOM_CONNECTOR_ID = "zoom";
export const ZOOM_MEETING_SCOPE = "meeting:write:meeting";
const ZOOM_OAUTH = "https://zoom.us/oauth";
const TIMEOUT_MS = 10_000;
/** Refresh this long before Zoom's stated expiry (1 h tokens). */
const EXPIRY_SLACK_MS = 60_000;

export interface ZoomAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Null when Zoom isn't configured on this brain (then the connector isn't registered at all). */
export function zoomConfigFromEnv(appUrl: string): ZoomAppConfig | null {
  const clientId = optional("ZOOM_CLIENT_ID");
  const clientSecret = optional("ZOOM_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: optional("ZOOM_REDIRECT_URI") ?? new URL("/api/connections/zoom/callback", appUrl).toString() };
}

export class ZoomNotConnectedError extends CapabilityDeniedError {
  constructor() {
    super("video.create_room", "Zoom is not connected. Ask the owner to connect Zoom from the dashboard's Connections screen.");
    this.name = "ZoomNotConnectedError";
  }
}

export class ZoomAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZoomAuthError";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
  scopes: string[];
}

/**
 * Zoom answers a dead refresh token with 400/401 and one of these `error` codes. `invalid_request`
 * is what Zoom actually returns for a used or revoked refresh token; a malformed request of our own
 * would also land here, which only costs a reconnect.
 */
const REAUTH_ERRORS = new Set(["invalid_grant", "invalid_request", "invalid_token"]);

/** Cross-instance mutex around a refresh. `acquire` resolves to a release function. */
export interface RefreshLock {
  acquire(): Promise<() => Promise<void>>;
}

/**
 * A refresh holding the lock can take two token requests (TIMEOUT_MS each) plus the save retries.
 * Waiters wait longer than that, and the TTL is longer still, so a slow holder isn't overtaken.
 */
const LOCK_WAIT_MS = 25_000;
const LOCK_TTL_SECONDS = 40;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * KV lock (`SET NX EX`). Waits up to `waitMs` for another instance's refresh; after that it goes
 * ahead unlocked (a stuck lock must not take Zoom down; the TTL frees it anyway).
 */
export class KvRefreshLock implements RefreshLock {
  constructor(
    private readonly kv: KV,
    private readonly key: string,
    private readonly opts: { ttlSeconds?: number; waitMs?: number; pollMs?: number } = {},
  ) {}

  async acquire(): Promise<() => Promise<void>> {
    const token = randomToken(12);
    const deadline = Date.now() + (this.opts.waitMs ?? LOCK_WAIT_MS);
    for (;;) {
      if (await this.kv.set(this.key, token, { nx: true, exSeconds: this.opts.ttlSeconds ?? LOCK_TTL_SECONDS })) {
        return async () => {
          // get + del is not atomic; the TTL is far longer than a refresh, so the key can only have
          // expired (and been re-taken) if this instance stalled well past it.
          if ((await this.kv.get(this.key)) === token) await this.kv.del(this.key);
        };
      }
      if (Date.now() >= deadline) {
        console.warn("[zoom] refresh lock still held; refreshing without it");
        return async () => undefined;
      }
      await sleep(this.opts.pollMs ?? 100);
    }
  }
}

export function zoomRefreshLock(kv: KV, prefix: string): KvRefreshLock {
  return new KvRefreshLock(kv, `${prefix}:conn:${ZOOM_CONNECTOR_ID}:refresh-lock`);
}

const SAVE_ATTEMPTS = 3;

export class ZoomAuth {
  private cached: { token: string; expiresAt: number; connectedAt: string } | null = null;
  private inflight: Promise<string> | null = null;
  /** A rotated refresh token we couldn't persist, and the stored one it replaced. */
  private pending: { from: string; secret: string } | null = null;

  constructor(
    private readonly cfg: ZoomAppConfig,
    private readonly connections: ConnectionStore,
    private readonly fetchFn: FetchLike = fetch,
    private readonly now: () => number = Date.now,
    private readonly lock?: RefreshLock,
    private readonly backoffMs = 150,
  ) {}

  /** Consent URL. `state` and the PKCE challenge come from `ConnectionStore.issueState` / `pkcePair`. */
  authorizeUrl(opts: { state: string; codeChallenge: string }): string {
    const u = new URL(`${ZOOM_OAUTH}/authorize`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", this.cfg.redirectUri);
    u.searchParams.set("state", opts.state);
    u.searchParams.set("code_challenge", opts.codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  }

  /** Callback step: exchange the code (with the PKCE verifier) and store the refresh token. */
  async exchangeCode(code: string, codeVerifier: string, connectedAt: string): Promise<StoredConnection> {
    const t = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri, code_verifier: codeVerifier });
    if (!t.refreshToken) throw new ZoomAuthError("Zoom did not return a refresh token.");
    const saved = await this.connections.save(ZOOM_CONNECTOR_ID, {
      secret: t.refreshToken,
      secretKind: "refresh_token",
      grantedScopes: t.scopes,
      connectedAt,
    });
    this.pending = null;
    this.cached = { token: t.accessToken, expiresAt: this.now() + t.expiresInSec * 1000, connectedAt: saved.connectedAt };
    return saved;
  }

  /** A valid access token. Concurrent callers in this instance share one refresh. */
  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - EXPIRY_SLACK_MS > this.now()) {
      // Reconnected since we cached? Then the cached token belongs to the old grant. (Another
      // instance's rotation changes the stored secret but not connectedAt, and our token stays valid.)
      const stored = await this.connections.load(ZOOM_CONNECTOR_ID);
      if (!stored) {
        this.cached = null;
        throw new ZoomNotConnectedError();
      }
      if (stored.connectedAt === this.cached.connectedAt) return this.cached.token;
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Drop the cached access token (e.g. after the API answered 401). */
  invalidate(): void {
    this.cached = null;
  }

  /** Best-effort revoke at Zoom (disconnect route, later slice). */
  async revoke(token: string): Promise<void> {
    const res = await this.fetchFn(`${ZOOM_OAUTH}/revoke`, {
      method: "POST",
      headers: { Authorization: this.basic(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new ZoomAuthError(`Zoom revoke failed (HTTP ${res.status}).`);
    this.cached = null;
  }

  private async refresh(): Promise<string> {
    const release = this.lock ? await this.lock.acquire() : null;
    try {
      // Read after taking the lock: the previous holder may have just rotated the token.
      const stored = await this.connections.load(ZOOM_CONNECTOR_ID);
      if (!stored) throw new ZoomNotConnectedError();
      if (this.pending && this.pending.from !== stored.secret) this.pending = null; // stored moved on
      const secret = this.pending?.secret ?? stored.secret;
      let t: TokenResponse;
      try {
        // failedSecret = the stored record's secret, so invokeCapability marks exactly that record.
        t = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: secret }, stored.secret);
      } catch (err) {
        // Without the lock (or after it timed out) another instance may have rotated the token
        // since our load: retry once with the newer one.
        if (!(err instanceof ReauthRequiredError)) throw err;
        const again = await this.connections.load(ZOOM_CONNECTOR_ID);
        if (!again || again.secret === stored.secret) throw err;
        this.pending = null;
        return await this.useRefreshed(again, await this.tokenRequest({ grant_type: "refresh_token", refresh_token: again.secret }, again.secret));
      }
      return await this.useRefreshed(stored, t);
    } finally {
      await release?.().catch((e: unknown) => console.warn("[zoom] refresh lock release failed", e));
    }
  }

  /** `from` is the stored record the refresh started from (its secret, or `pending` replacing it). */
  private async useRefreshed(from: StoredConnection, t: TokenResponse): Promise<string> {
    const rotated = t.refreshToken && t.refreshToken !== (this.pending?.secret ?? from.secret) ? t.refreshToken : undefined;
    const newSecret = rotated ?? this.pending?.secret;
    if (newSecret) {
      // Persist before use, or the next refresh would fail. Only replace the record we refreshed
      // from (a reconnect since then wins). A valid refresh also clears a `needs_reauth` that a
      // racing instance may have set.
      let saved = false;
      for (let attempt = 1; attempt <= SAVE_ATTEMPTS && !saved; attempt++) {
        try {
          const updated = await this.connections.update(ZOOM_CONNECTOR_ID, (v) => {
            if (v.secret !== from.secret) return v;
            const { lastError: _drop, ...rest } = v;
            return { ...rest, secret: newSecret, status: "connected", ...(t.scopes.length ? { grantedScopes: t.scopes } : {}) };
          });
          if (!updated) throw new ZoomNotConnectedError();
          saved = true;
        } catch (err) {
          if (err instanceof ZoomNotConnectedError) throw err;
          console.error(`[zoom] saving the rotated refresh token failed (attempt ${attempt}/${SAVE_ATTEMPTS})`, (err as Error)?.message);
          if (attempt < SAVE_ATTEMPTS) await sleep(this.backoffMs * attempt);
        }
      }
      // Keep it in memory so this instance can still refresh; the stored token is already dead.
      // Limitation: only this instance knows it. If another instance refreshes from the dead
      // stored token first, the connection is marked needs_reauth and the owner must reconnect.
      this.pending = saved ? null : { from: from.secret, secret: newSecret };
    }
    this.cached = { token: t.accessToken, expiresAt: this.now() + t.expiresInSec * 1000, connectedAt: from.connectedAt };
    return t.accessToken;
  }

  private basic(): string {
    return `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`;
  }

  private async tokenRequest(form: Record<string, string>, refreshSecret?: string): Promise<TokenResponse> {
    const res = await this.fetchFn(`${ZOOM_OAUTH}/token`, {
      method: "POST",
      headers: { Authorization: this.basic(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof body.error === "string" ? body.error : "";
      if ((res.status === 400 || res.status === 401) && REAUTH_ERRORS.has(code) && form.grant_type === "refresh_token") {
        throw new ReauthRequiredError(ZOOM_CONNECTOR_ID, "Zoom rejected the stored sign-in. Ask the owner to reconnect Zoom.", refreshSecret);
      }
      // Never echo the response body: it can contain token material on some error paths.
      throw new ZoomAuthError(`Zoom sign-in failed (HTTP ${res.status}${code ? `, ${code.slice(0, 40)}` : ""}).`);
    }
    if (typeof body.access_token !== "string" || !body.access_token) throw new ZoomAuthError("Zoom returned no access token.");
    const expires = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
    return {
      accessToken: body.access_token,
      ...(typeof body.refresh_token === "string" && body.refresh_token ? { refreshToken: body.refresh_token } : {}),
      expiresInSec: expires,
      scopes: parseScopes(typeof body.scope === "string" ? body.scope : undefined),
    };
  }
}
