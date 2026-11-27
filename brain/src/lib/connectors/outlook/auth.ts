import { optional } from "../../env";
import { OutlookMail, type OutlookTokenSource } from "../../microsoft/mail";
import { parseScopes, type ConnectionStore, type StoredConnection } from "../store";
import { CapabilityDeniedError, ReauthRequiredError } from "../types";

/**
 * Microsoft sign-in for the `outlook` connector (docs/CONNECTORS.md §7). Microsoft identity
 * platform v2 endpoints, authorization code + PKCE (S256), confidential web client (client secret in
 * the form body). Scopes: `offline_access User.Read` for the sign-in itself plus `Mail.Read` for
 * `email.read`. Nothing here can draft, send, move or delete mail.
 *
 * The refresh token is stored by `ConnectionStore` under connector id "outlook" (AAD-bound). Access
 * tokens live in memory only and are tied to the record's `connectedAt`, so a reconnect or
 * disconnect drops them.
 *
 * Rotation: Microsoft may return a new refresh token on each refresh. Unlike Zoom, the previous
 * one is not revoked when that happens (it stays valid until its own expiry), so there is no
 * cross-instance lock: the rotated token is written back best effort, only over the record we
 * refreshed from. (From memory of Microsoft's docs: verify on the first real connect.)
 *
 * The connect/callback/disconnect legs are the generic `/api/connections/outlook/*` routes, through
 * the `OAuthFlow` in ./oauth.ts. Microsoft has no OAuth token revocation endpoint, so disconnect
 * deletes the stored token only; the owner removes the app's consent at
 * account.live.com/consent/Manage (personal) or myapps.microsoft.com (work/school).
 */

export const OUTLOOK_CONNECTOR_ID = "outlook";
/** Always requested: refresh token + the account's own address for the label. */
export const OUTLOOK_LOGIN_SCOPES = ["offline_access", "User.Read"] as const;
export const OUTLOOK_MAIL_READ_SCOPE = "Mail.Read";
/** Every scope the connect step asks for (email.read is the only capability in this slice). */
export const OUTLOOK_REQUESTED_SCOPES = [...OUTLOOK_LOGIN_SCOPES, OUTLOOK_MAIL_READ_SCOPE] as const;

const LOGIN_ORIGIN = "https://login.microsoftonline.com";
const GRAPH_SCOPE_PREFIX = "https://graph.microsoft.com/";
const TIMEOUT_MS = 10_000;
/** Refresh this long before Microsoft's stated expiry (usually 60-90 min tokens). */
const EXPIRY_SLACK_MS = 60_000;
/** `common` (work/school + personal), `organizations`, `consumers`, or a tenant id / domain. */
const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,99}$/;

export interface MicrosoftAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenant: string;
}

/** Null when Microsoft isn't configured on this brain (then the connector isn't registered at all). */
export function microsoftConfigFromEnv(appUrl: string): MicrosoftAppConfig | null {
  const clientId = optional("MICROSOFT_CLIENT_ID");
  const clientSecret = optional("MICROSOFT_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  const tenant = optional("MICROSOFT_TENANT") ?? "common";
  if (!TENANT_RE.test(tenant)) {
    // Don't take every route down over one bad optional setting: leave Outlook unregistered.
    console.error("[outlook] MICROSOFT_TENANT must be common, organizations, consumers, a tenant id or a domain; Outlook is disabled");
    return null;
  }
  return {
    clientId,
    clientSecret,
    tenant,
    redirectUri: optional("MICROSOFT_REDIRECT_URI") ?? new URL("/api/connections/outlook/callback", appUrl).toString(),
  };
}

export class OutlookNotConnectedError extends CapabilityDeniedError {
  constructor() {
    super("email.read", "Outlook is not connected. Ask the owner to connect Outlook from the dashboard's Connections screen.");
    this.name = "OutlookNotConnectedError";
  }
}

/** Sign-in failures that a reconnect won't necessarily fix. Messages never carry response bodies or tokens. */
export class MicrosoftAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicrosoftAuthError";
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Microsoft answers a dead or consent-revoked refresh token with 400 and one of these. A refresh
 * that needs MFA again or new consent (`interaction_required`, `consent_required`) also needs the
 * owner to sign in again. `invalid_client` (our app secret expired) is NOT here: reconnecting
 * wouldn't help, the brain's MICROSOFT_CLIENT_SECRET must be renewed.
 */
const REAUTH_ERRORS = new Set(["invalid_grant", "interaction_required", "consent_required", "login_required"]);

const KNOWN_SCOPES = ["openid", "profile", "email", ...OUTLOOK_REQUESTED_SCOPES];

/**
 * Microsoft returns Graph scopes as full URIs (`https://graph.microsoft.com/Mail.Read`) or short
 * names, in any case, and usually leaves `offline_access` out. Maps them to the short names used by
 * the connector's `scopesFor`, so `effectiveCapabilities` compares like with like.
 */
export function normalizeGrantedScopes(scope: string | undefined | null, gotRefreshToken: boolean): string[] {
  const out = parseScopes(scope).map((s) => {
    const short = s.toLowerCase().startsWith(GRAPH_SCOPE_PREFIX) ? s.slice(GRAPH_SCOPE_PREFIX.length) : s;
    return KNOWN_SCOPES.find((k) => k.toLowerCase() === short.toLowerCase()) ?? short;
  });
  if (gotRefreshToken && !out.includes("offline_access")) out.push("offline_access");
  return [...new Set(out)];
}

interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
  scopes: string[];
}

export class MicrosoftAuth implements OutlookTokenSource {
  private cached: { token: string; expiresAt: number; connectedAt: string } | null = null;
  private inflight: Promise<string> | null = null;
  /** Bumped by every code exchange and forget, so a refresh started before one can't cache its token after it. */
  private generation = 0;

  constructor(
    private readonly cfg: MicrosoftAppConfig,
    private readonly connections: ConnectionStore,
    private readonly fetchFn: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private endpoint(leg: "authorize" | "token"): string {
    return `${LOGIN_ORIGIN}/${encodeURIComponent(this.cfg.tenant)}/oauth2/v2.0/${leg}`;
  }

  /** Consent URL. `state` and the PKCE challenge come from `ConnectionStore.issueState` / `pkcePair`. */
  authorizeUrl(opts: { state: string; codeChallenge: string }): string {
    const u = new URL(this.endpoint("authorize"));
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", this.cfg.redirectUri);
    u.searchParams.set("response_mode", "query");
    u.searchParams.set("scope", OUTLOOK_REQUESTED_SCOPES.join(" "));
    u.searchParams.set("state", opts.state);
    u.searchParams.set("code_challenge", opts.codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    // Let the owner pick which Microsoft account to connect instead of silently reusing a session.
    u.searchParams.set("prompt", "select_account");
    return u.toString();
  }

  /**
   * Callback step 1: exchange the code (with the PKCE verifier). Nothing is stored yet, so the
   * flow can check the account before saving. Returns the access token for that check.
   */
  async exchangeCode(code: string, codeVerifier: string): Promise<{ accessToken: string; refreshToken: string; scopes: string[]; expiresInSec: number }> {
    const t = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.cfg.redirectUri,
      code_verifier: codeVerifier,
      scope: OUTLOOK_REQUESTED_SCOPES.join(" "),
    });
    if (!t.refreshToken) throw new MicrosoftAuthError("Microsoft did not return a refresh token.");
    return { accessToken: t.accessToken, refreshToken: t.refreshToken, scopes: t.scopes, expiresInSec: t.expiresInSec };
  }

  /** Callback step 2: store the refresh token. A reconnect keeps the owner's capability switches. */
  async saveConnection(t: { accessToken: string; refreshToken: string; scopes: string[]; expiresInSec: number }, connectedAt: string, account?: string): Promise<StoredConnection> {
    this.generation++;
    const previous = await this.connections.load(OUTLOOK_CONNECTOR_ID).catch(() => null);
    const saved = await this.connections.save(OUTLOOK_CONNECTOR_ID, {
      secret: t.refreshToken,
      secretKind: "refresh_token",
      ...(account ? { account } : {}),
      grantedScopes: t.scopes,
      connectedAt,
      ...(previous?.enabled ? { enabled: previous.enabled } : {}),
      status: "connected",
    });
    this.cached = { token: t.accessToken, expiresAt: this.now() + t.expiresInSec * 1000, connectedAt: saved.connectedAt };
    return saved;
  }

  /** The mailbox address for a fresh access token (Graph `/me`, User.Read), through the read-only mail module. */
  async readAccount(accessToken: string): Promise<string | undefined> {
    const mail = new OutlookMail({ accessToken: async () => accessToken }, { fetch: (url, init) => this.fetchFn(url, init) });
    return (await mail.account()).email;
  }

  /** A valid Graph access token. Concurrent callers in this instance share one refresh. */
  async accessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - EXPIRY_SLACK_MS > this.now()) {
      // Reconnected or disconnected since we cached? Then the cached token belongs to the old grant.
      const stored = await this.connections.load(OUTLOOK_CONNECTOR_ID);
      if (!stored) {
        this.cached = null;
        throw new OutlookNotConnectedError();
      }
      if (stored.connectedAt === this.cached.connectedAt) return this.cached.token;
    }
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Drop the cached access token (Graph answered 401). */
  invalidate(): void {
    this.cached = null;
  }

  /** Forget everything in memory (disconnect). Microsoft has no token revocation endpoint. */
  forget(): void {
    this.cached = null;
    this.generation++;
  }

  private async refresh(): Promise<string> {
    const generation = this.generation;
    const stored = await this.connections.load(OUTLOOK_CONNECTOR_ID);
    if (!stored) throw new OutlookNotConnectedError();
    const t = await this.tokenRequest(
      { grant_type: "refresh_token", refresh_token: stored.secret, scope: OUTLOOK_REQUESTED_SCOPES.join(" ") },
      stored.secret,
    );
    if (t.refreshToken && t.refreshToken !== stored.secret) {
      // Best effort: the old refresh token stays valid at Microsoft, so a failed write only means
      // the next refresh uses the older one. Only replace the record we refreshed from.
      const rotated = t.refreshToken;
      await this.connections
        .update(OUTLOOK_CONNECTOR_ID, (v) => {
          if (v.secret !== stored.secret || v.connectedAt !== stored.connectedAt) return v;
          const { lastError: _drop, ...rest } = v;
          return { ...rest, secret: rotated, status: "connected", ...(t.scopes.length ? { grantedScopes: t.scopes } : {}) };
        })
        .catch((err: unknown) => console.warn("[outlook] saving the rotated refresh token failed", (err as Error)?.name));
    }
    if (generation === this.generation) {
      this.cached = { token: t.accessToken, expiresAt: this.now() + t.expiresInSec * 1000, connectedAt: stored.connectedAt };
    }
    return t.accessToken;
  }

  private async tokenRequest(form: Record<string, string>, refreshSecret?: string): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(this.endpoint("token"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ ...form, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new MicrosoftAuthError(`Microsoft sign-in didn't answer (${(err as Error)?.name === "TimeoutError" ? "timed out" : "network error"}).`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof body.error === "string" ? body.error : "";
      if (res.status >= 400 && res.status < 500 && REAUTH_ERRORS.has(code) && form.grant_type === "refresh_token") {
        throw new ReauthRequiredError(OUTLOOK_CONNECTOR_ID, "Microsoft rejected the stored sign-in. Ask the owner to reconnect Outlook.", refreshSecret);
      }
      // Never echo the response body (error_description can quote request details).
      throw new MicrosoftAuthError(`Microsoft sign-in failed (HTTP ${res.status}${code ? `, ${code.replace(/[^a-z_]/g, "").slice(0, 40)}` : ""}).`);
    }
    if (typeof body.access_token !== "string" || !body.access_token) throw new MicrosoftAuthError("Microsoft returned no access token.");
    const refreshToken = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined;
    const expires = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600;
    return {
      accessToken: body.access_token,
      ...(refreshToken ? { refreshToken } : {}),
      expiresInSec: expires,
      scopes: normalizeGrantedScopes(typeof body.scope === "string" ? body.scope : undefined, refreshToken !== undefined),
    };
  }
}
