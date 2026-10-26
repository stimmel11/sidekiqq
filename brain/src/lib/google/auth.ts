import { google } from "googleapis";
import { z } from "zod";
import type { KV } from "../kv";
import { config, optional, required } from "../env";
import { decrypt, encrypt, randomToken } from "../crypto";

/**
 * Single-owner Google OAuth. The refresh token is the only long-lived Google secret and is
 * stored AES-256-GCM encrypted in Redis (AAD-bound to its purpose). Access tokens are minted
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

const AAD = "sidekiqq:google-refresh-token:v1";

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

export class GoogleTokenStore {
  constructor(
    private readonly kv: KV,
    private readonly prefix: string,
    private readonly key: () => Buffer,
  ) {}

  private get tokenKey() {
    return `${this.prefix}:google:tokens`;
  }

  async save(v: StoredGoogle): Promise<void> {
    const payload = encrypt(JSON.stringify(StoredGoogleSchema.parse(v)), this.key(), AAD);
    await this.kv.set(this.tokenKey, payload);
  }

  async load(): Promise<StoredGoogle | null> {
    const raw = await this.kv.get(this.tokenKey);
    if (!raw) return null;
    try {
      return StoredGoogleSchema.parse(JSON.parse(decrypt(raw, this.key(), AAD)));
    } catch (err) {
      console.error("[google] stored token could not be decrypted; reconnect required", err);
      return null;
    }
  }

  async clear(): Promise<void> {
    await this.kv.del(this.tokenKey);
  }

  /** OAuth `state` nonce: single-use, 10-minute TTL. */
  async issueState(): Promise<string> {
    const state = randomToken(24);
    await this.kv.set(`${this.prefix}:google:state:${state}`, "1", { exSeconds: 600 });
    return state;
  }

  async consumeState(state: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) return false;
    return (await this.kv.getdel(`${this.prefix}:google:state:${state}`)) !== null;
  }

  /**
   * Single-use, short-lived ticket for opening /api/google/connect in a browser, so the owner
   * secret itself never has to appear in a URL (URLs land in Vercel request logs and history).
   */
  async issueConnectTicket(ttlSeconds = 300): Promise<string> {
    const ticket = randomToken(24);
    await this.kv.set(`${this.prefix}:google:ticket:${ticket}`, "1", { exSeconds: ttlSeconds });
    return ticket;
  }

  async consumeConnectTicket(ticket: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(ticket)) return false;
    return (await this.kv.getdel(`${this.prefix}:google:ticket:${ticket}`)) !== null;
  }

  /** An authorised OAuth2 client for the owner, or throws GoogleNotConnectedError. */
  async authorizedClient(): Promise<OAuth2Client> {
    const stored = await this.load();
    if (!stored) throw new GoogleNotConnectedError();
    const client = createOAuthClient();
    client.setCredentials({ refresh_token: stored.refreshToken });
    return client;
  }
}
