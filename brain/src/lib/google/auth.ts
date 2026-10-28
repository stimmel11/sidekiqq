import { google } from "googleapis";
import { z } from "zod";
import { config, optional, required } from "../env";
import { parseScopes, type ConnectionStore } from "../connectors/store";

/**
 * Single-owner Google OAuth. The refresh token is the only long-lived Google secret and is
 * stored AES-256-GCM encrypted in Redis by `ConnectionStore` (AAD-bound to the connector). Access tokens are minted
 * on demand by the OAuth2 client and never persisted.
 */

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  // compose = create drafts + send drafts. Sending is still only reachable via /api/drafts/:id/approve.
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  // contacts.lookup (lib/google/contacts.ts): saved contacts + Gmail's auto-created "Other contacts". Read-only.
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
] as const;

/** The Google record as the OAuth routes see it. Stored by `ConnectionStore` under connector id "google". */
const StoredGoogleSchema = z.object({
  refreshToken: z.string(),
  email: z.string().optional(),
  scope: z.string().optional(),
  connectedAt: z.string(),
});
export type StoredGoogle = z.infer<typeof StoredGoogleSchema>;

export class GoogleNotConnectedError extends Error {
  constructor() {
    super("Google account is not connected. The owner must visit /api/google/connect.");
    this.name = "GoogleNotConnectedError";
  }
}

export type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

export function redirectUri(): string {
  return optional("GOOGLE_REDIRECT_URI") ?? `${config.appUrl()}/api/google/callback`;
}

export function createOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(required("GOOGLE_CLIENT_ID"), required("GOOGLE_CLIENT_SECRET"), redirectUri());
}

/**
 * Google's view of the generic `ConnectionStore` (docs/CONNECTORS.md §7, §8 step 3). Keeps the
 * API the Google OAuth routes use; storage, AAD, key rotation and the legacy-record migration
 * live in `ConnectionStore`.
 */
export class GoogleTokenStore {
  constructor(private readonly connections: ConnectionStore) {}

  /** Saves a fresh connect. Keeps the owner's enabled capabilities from an earlier connect, and clears needs_reauth. */
  async save(v: StoredGoogle): Promise<void> {
    const parsed = StoredGoogleSchema.parse(v);
    const existing = await this.connections.load("google");
    await this.connections.save("google", {
      secret: parsed.refreshToken,
      secretKind: "refresh_token",
      ...(parsed.email ? { account: parsed.email } : {}),
      grantedScopes: parseScopes(parsed.scope),
      connectedAt: parsed.connectedAt,
      ...(existing?.enabled ? { enabled: existing.enabled } : {}),
      status: "connected",
    });
  }

  async load(): Promise<StoredGoogle | null> {
    const c = await this.connections.load("google");
    if (!c) return null;
    return {
      refreshToken: c.secret,
      ...(c.account ? { email: c.account } : {}),
      ...(c.grantedScopes.length ? { scope: c.grantedScopes.join(" ") } : {}),
      connectedAt: c.connectedAt,
    };
  }

  async clear(): Promise<void> {
    await this.connections.clear("google");
  }

  /** OAuth `state` nonce (single use, 10 minutes) bound to the PKCE code verifier. */
  issueState(codeVerifier: string): Promise<string> {
    return this.connections.issueState("google", codeVerifier);
  }

  /** The PKCE code verifier for a valid, unused state; null otherwise. */
  consumeState(state: string): Promise<string | null> {
    return this.connections.consumeState("google", state);
  }

  /**
   * Single-use, short-lived ticket for opening /api/google/connect in a browser, so the owner
   * secret itself never has to appear in a URL (URLs land in Vercel request logs and history).
   */
  issueConnectTicket(ttlSeconds = 300): Promise<string> {
    return this.connections.issueConnectTicket("google", ttlSeconds);
  }

  consumeConnectTicket(ticket: string): Promise<boolean> {
    return this.connections.consumeConnectTicket("google", ticket);
  }

  /** An authorised OAuth2 client for the owner, or throws GoogleNotConnectedError. */
  async authorizedClient(): Promise<OAuth2Client> {
    const stored = await this.connections.load("google");
    if (!stored) throw new GoogleNotConnectedError();
    const client = createOAuthClient();
    client.setCredentials({ refresh_token: stored.secret });
    return client;
  }
}
