import { optional } from "../../env";
import { KROGER_SCOPES, KrogerAuthError } from "../../kroger/grocery";
import { parseScopes, type ConnectionStore, type StoredConnection } from "../store";
import { CapabilityDeniedError, ReauthRequiredError } from "../types";
import { KvRefreshLock, type FetchLike, type RefreshLock } from "../zoom/auth";
import type { KV } from "../../kv";

/**
 * Kroger / King Soopers sign-in for the `kroger` connector (docs/CONNECTORS.md §7; backlog
 * "Connector: Kroger" slice 2a). Two kinds of token, both minted on demand and kept in memory only:
 *
 *  - Owner token (authorization code + PKCE): scopes `product.compact cart.basic:write`. The
 *    refresh token is stored encrypted by `ConnectionStore` under connector id "kroger". Kroger may
 *    return a new refresh token on refresh, so (as for Zoom) refreshes are serialised with a KV
 *    lock, the latest stored token is read after taking it, and a rotated token is written back
 *    before the access token is used (kept in memory if every write fails).
 *  - App token (client credentials, `product.compact` only): lets product search run without the
 *    owner's token. A failure here is a server config problem (`KrogerAuthError` with
 *    `appCredentials`), never `needs_reauth`.
 *
 * This module only signs in and mints tokens. It cannot search or touch the cart (lib/kroger), and
 * Kroger's public API has no checkout, order or payment endpoint anyway. No token material ever
 * goes into an error message or a log line.
 *
 * Wire details (authorize/token paths, Basic client auth, `expires_in` 1800, PKCE support, the
 * error codes for a dead refresh token, whether refresh rotates) are from Kroger's public docs as
 * remembered, not checked against the live API: verify on the first real connect. Kroger
 * documents no token revoke endpoint, so disconnect will only delete the stored token.
 */

export const KROGER_CONNECTOR_ID = "kroger";
export const KROGER_OAUTH_BASE = "https://api.kroger.com/v1/connect/oauth2";
/** What the owner's sign-in asks for: search + add-only cart. Nothing that reads profile, orders or payment. */
export const KROGER_USER_SCOPES = [KROGER_SCOPES.search, KROGER_SCOPES.cart] as const;
const TIMEOUT_MS = 10_000;
const EXPIRY_SLACK_MS = 60_000;
/** Kroger's tokens last 30 minutes; used when `expires_in` is missing or junk. */
const DEFAULT_EXPIRES_SEC = 1800;
const SAVE_ATTEMPTS = 3;

export interface KrogerAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Null when Kroger isn't configured on this brain (then the connector isn't registered at all). */
export function krogerConfigFromEnv(appUrl: string): KrogerAppConfig | null {
  const clientId = optional("KROGER_CLIENT_ID");
  const clientSecret = optional("KROGER_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: optional("KROGER_REDIRECT_URI") ?? new URL("/api/connections/kroger/callback", appUrl).toString(),
  };
}

export class KrogerNotConnectedError extends CapabilityDeniedError {
  constructor() {
    super("grocery.cart.add", "Kroger is not connected. Ask the owner to connect Kroger from the dashboard's Connections screen.");
    this.name = "KrogerNotConnectedError";
  }
}

/** Sign-in failed for a reason other than a dead refresh token (network, misconfig, odd response). */
export class KrogerSignInError extends Error {
  constructor(
    message: string,
    /** HTTP status of Kroger's token endpoint, when it answered. */
    readonly status?: number,
  ) {
    super(message);
    this.name = "KrogerSignInError";
  }
}

export function krogerRefreshLock(kv: KV, prefix: string): KvRefreshLock {
  return new KvRefreshLock(kv, `${prefix}:conn:${KROGER_CONNECTOR_ID}:refresh-lock`);
}

/** Codes an OAuth server uses for a refresh token that no longer works. */
const REAUTH_ERRORS = new Set(["invalid_grant", "invalid_token"]);

interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
  /** As granted; empty when the response had no `scope`. */
  scopes: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class KrogerAuth {
  private cached: { token: string; expiresAt: number; connectedAt: string } | null = null;
  private inflight: Promise<string> | null = null;
  /** A rotated refresh token we couldn't persist, and the stored one it replaced. */
  private pending: { from: string; secret: string } | null = null;
  private app: { token: string; expiresAt: number } | null = null;
  private appInflight: Promise<string> | null = null;

  constructor(
    private readonly cfg: KrogerAppConfig,
    private readonly connections: ConnectionStore,
    private readonly fetchFn: FetchLike = fetch,
    private readonly now: () => number = Date.now,
    private readonly lock?: RefreshLock,
    private readonly backoffMs = 150,
  ) {}

  /** Consent URL. `state` and the PKCE challenge come from `ConnectionStore.issueState` / `pkcePair`. */
  authorizeUrl(opts: { state: string; codeChallenge: string }): string {
    const u = new URL(`${KROGER_OAUTH_BASE}/authorize`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", this.cfg.redirectUri);
    u.searchParams.set("scope", KROGER_USER_SCOPES.join(" "));
    u.searchParams.set("state", opts.state);
    u.searchParams.set("code_challenge", opts.codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  }

  /** Callback step: exchange the code (with the PKCE verifier) and store the refresh token. */
  async exchangeCode(code: string, codeVerifier: string, connectedAt: string): Promise<StoredConnection> {
    const t = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri, code_verifier: codeVerifier });
    if (!t.refreshToken) throw new KrogerSignInError("Kroger did not return a refresh token.");
    const saved = await this.connections.save(KROGER_CONNECTOR_ID, {
      secret: t.refreshToken,
      secretKind: "refresh_token",
      // A token response without `scope` means the requested scopes were granted (RFC 6749 §5.1).
      grantedScopes: t.scopes.length ? t.scopes : [...KROGER_USER_SCOPES],
      connectedAt,
    });
    this.pending = null;
    this.cached = { token: t.accessToken, expiresAt: this.now() + t.expiresInSec * 1000, connectedAt: saved.connectedAt };
    return saved;
  }

  /** The owner's access token (search + cart). Concurrent callers in this instance share one refresh. */
  async userToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - EXPIRY_SLACK_MS > this.now()) {
      // Reconnected (or disconnected) since we cached? Then the cached token belongs to the old grant.
      const stored = await this.connections.load(KROGER_CONNECTOR_ID);
      if (!stored) {
        this.cached = null;
        throw new KrogerNotConnectedError();
      }
      if (stored.connectedAt === this.cached.connectedAt) return this.cached.token;
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /**
   * App token for product search (client credentials, `product.compact` only). Works whether or
   * not the owner connected Kroger. Failures are `KrogerAuthError(status, true)` or
   * `KrogerSignInError`, never `ReauthRequiredError`.
   */
  async appToken(): Promise<string> {
    if (this.app && this.app.expiresAt - EXPIRY_SLACK_MS > this.now()) return this.app.token;
    this.appInflight ??= (async () => {
      let t: TokenResponse;
      try {
        t = await this.tokenRequest({ grant_type: "client_credentials", scope: KROGER_SCOPES.search });
      } catch (err) {
        // 400 invalid_client / 401 / 403: the client id/secret or the app's scopes are wrong.
        if (err instanceof KrogerSignInError && (err.status === 400 || err.status === 401 || err.status === 403)) {
          throw new KrogerAuthError(err.status, true);
        }
        throw err;
      }
      this.app = { token: t.accessToken, expiresAt: this.now() + t.expiresInSec * 1000 };
      return t.accessToken;
    })().finally(() => {
      this.appInflight = null;
    });
    return this.appInflight;
  }

  /** Drop the cached owner token (the cart API answered 401). The app token is kept. */
  invalidateUser(): void {
    this.cached = null;
  }

  /** Drop the cached app token (product search answered 401 on it). The owner token is kept. */
  invalidateApp(): void {
    this.app = null;
  }

  private async refresh(): Promise<string> {
    const release = this.lock ? await this.lock.acquire() : null;
    try {
      // Read after taking the lock: the previous holder may have just rotated the token.
      const stored = await this.connections.load(KROGER_CONNECTOR_ID);
      if (!stored) throw new KrogerNotConnectedError();
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
        const again = await this.connections.load(KROGER_CONNECTOR_ID);
        if (!again || again.secret === stored.secret) throw err;
        this.pending = null;
        return await this.useRefreshed(again, await this.tokenRequest({ grant_type: "refresh_token", refresh_token: again.secret }, again.secret));
      }
      return await this.useRefreshed(stored, t);
    } finally {
      await release?.().catch((e: unknown) => console.warn("[kroger] refresh lock release failed", (e as Error)?.message));
    }
  }

  /** `from` is the stored record the refresh started from (its secret, or `pending` replacing it). */
  private async useRefreshed(from: StoredConnection, t: TokenResponse): Promise<string> {
    const rotated = t.refreshToken && t.refreshToken !== (this.pending?.secret ?? from.secret) ? t.refreshToken : undefined;
    const newSecret = rotated ?? this.pending?.secret;
    if (newSecret) {
      // Persist before use, or the next refresh may fail. Only replace the record we refreshed
      // from (a reconnect since then wins). A valid refresh also clears a racing `needs_reauth`.
      let saved = false;
      for (let attempt = 1; attempt <= SAVE_ATTEMPTS && !saved; attempt++) {
        try {
          const updated = await this.connections.update(KROGER_CONNECTOR_ID, (v) => {
            if (v.secret !== from.secret) return v;
            const { lastError: _drop, ...rest } = v;
            return { ...rest, secret: newSecret, status: "connected", ...(t.scopes.length ? { grantedScopes: t.scopes } : {}) };
          });
          if (!updated) throw new KrogerNotConnectedError();
          saved = true;
        } catch (err) {
          if (err instanceof KrogerNotConnectedError) throw err;
          console.error(`[kroger] saving the rotated refresh token failed (attempt ${attempt} of ${SAVE_ATTEMPTS})`, (err as Error)?.message);
          if (attempt < SAVE_ATTEMPTS) await sleep(this.backoffMs * attempt);
        }
      }
      this.pending = saved ? null : { from: from.secret, secret: newSecret };
    }
    this.cached = { token: t.accessToken, expiresAt: this.now() + t.expiresInSec * 1000, connectedAt: from.connectedAt };
    return t.accessToken;
  }

  private basic(): string {
    return `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`;
  }

  private async tokenRequest(form: Record<string, string>, refreshSecret?: string): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(`${KROGER_OAUTH_BASE}/token`, {
        method: "POST",
        headers: { Authorization: this.basic(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      throw new KrogerSignInError(`Kroger sign-in ${name === "TimeoutError" || name === "AbortError" ? "timed out" : "failed (network error)"}.`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof body.error === "string" ? body.error : "";
      if ((res.status === 400 || res.status === 401) && REAUTH_ERRORS.has(code) && form.grant_type === "refresh_token") {
        throw new ReauthRequiredError(KROGER_CONNECTOR_ID, "Kroger rejected the stored sign-in. Ask the owner to reconnect Kroger.", refreshSecret);
      }
      // Never echo the response body: some error paths can carry token material.
      const safeCode = /^[a-z_]{1,40}$/.test(code) ? `, ${code}` : "";
      throw new KrogerSignInError(`Kroger sign-in failed (HTTP ${res.status}${safeCode}).`, res.status);
    }
    if (typeof body.access_token !== "string" || !body.access_token) throw new KrogerSignInError("Kroger returned no access token.");
    const expires = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0 ? body.expires_in : DEFAULT_EXPIRES_SEC;
    return {
      accessToken: body.access_token,
      ...(typeof body.refresh_token === "string" && body.refresh_token ? { refreshToken: body.refresh_token } : {}),
      expiresInSec: expires,
      scopes: parseScopes(typeof body.scope === "string" ? body.scope : undefined),
    };
  }
}
