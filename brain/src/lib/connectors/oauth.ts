import type { Deps } from "../deps";
import { googleOAuth } from "./google/oauth";

/**
 * Per-connector OAuth flows behind the generic connections routes (docs/CONNECTORS.md §7, §9).
 * A flow only signs the owner in and stores the credential in `ConnectionStore`; it has no
 * access to any capability and cannot send anything.
 */

/** Why a callback did not connect. Codes, not free text, so they can go in a redirect URL. */
export const CONNECT_RESULTS = ["connected", "cancelled", "invalid", "expired", "no_refresh_token", "wrong_account", "failed"] as const;
export type ConnectResultCode = (typeof CONNECT_RESULTS)[number];

export type ConnectResult = { code: "connected"; account?: string } | { code: Exclude<ConnectResultCode, "connected">; detail?: string };

export interface OAuthFlow {
  /** Provider consent URL. Creates the single-use `state` (with its PKCE verifier) first. */
  authUrl(deps: Deps): Promise<string>;
  /** Handles the provider redirect: validates `state`, exchanges the code, stores the credential. */
  complete(deps: Deps, query: URLSearchParams): Promise<ConnectResult>;
  /** Revokes the stored credential at the provider. Throws on failure; callers treat it as best effort. */
  revoke?(secret: string): Promise<void>;
}

const FLOWS: Record<string, OAuthFlow> = {
  google: googleOAuth,
};

export function oauthFlow(connectorId: string): OAuthFlow | undefined {
  return Object.prototype.hasOwnProperty.call(FLOWS, connectorId) ? FLOWS[connectorId] : undefined;
}

export function isConnectResultCode(x: string | null | undefined): x is ConnectResultCode {
  return typeof x === "string" && (CONNECT_RESULTS as readonly string[]).includes(x);
}

/** HTTP status and owner-facing words for each result (callback page and Connections screen). */
export const CONNECT_RESULT_TEXT: Record<ConnectResultCode, { status: number; title: string; message: string }> = {
  connected: { status: 200, title: "Connected", message: "Connected. SideKiqq never sends anything without your approval." },
  cancelled: { status: 400, title: "Connection cancelled", message: "The sign-in was cancelled or refused, so nothing changed." },
  invalid: { status: 400, title: "Invalid callback", message: "The sign-in reply was missing its code or state. Start again from Connections." },
  expired: { status: 400, title: "Link expired", message: "That sign-in link expired or was already used. Start again from Connections." },
  no_refresh_token: {
    status: 400,
    title: "No refresh token",
    message: "Google did not return a refresh token. Remove SideKiqq's access at myaccount.google.com/permissions and connect again.",
  },
  wrong_account: { status: 403, title: "Wrong account", message: "That account isn't the one this SideKiqq brain accepts, so nothing was saved." },
  failed: { status: 500, title: "Connection failed", message: "The sign-in couldn't be completed. Check the server logs and try again." },
};
