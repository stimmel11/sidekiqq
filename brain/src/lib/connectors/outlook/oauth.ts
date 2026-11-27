import type { Deps } from "../../deps";
import { pkcePair } from "../../crypto";
import { optional } from "../../env";
import type { ConnectResult, OAuthFlow } from "../oauth";
import { MicrosoftAuthError, OUTLOOK_CONNECTOR_ID } from "./auth";

/**
 * Microsoft sign-in for the `outlook` connector behind the generic `/api/connections/outlook/*`
 * routes (docs/CONNECTORS.md §7). Thin wrapper around `MicrosoftAuth`: the single-use `state` and
 * its PKCE verifier live in `ConnectionStore` (10-minute TTL), the refresh token is stored
 * encrypted under connector id "outlook", and nothing here can read, draft or send mail.
 *
 * Only reachable when Microsoft is configured (`MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`):
 * otherwise the connector isn't registered, so the connect route 404s, and the callback answers
 * `failed`.
 *
 * `MICROSOFT_ALLOWED_EMAIL` (optional) works like `GOOGLE_ALLOWED_EMAIL`: any other mailbox is
 * refused and nothing is saved. The account label comes from Graph `/me` (User.Read).
 *
 * No `revoke`: Microsoft has no OAuth token revocation endpoint. Disconnect deletes the stored token
 * (a cached access token then stops working: `MicrosoftAuth` re-checks the record on every use); the
 * owner removes the app's consent in their Microsoft account if they want the grant gone too.
 */

export const outlookOAuth: OAuthFlow = {
  async authUrl(deps: Deps): Promise<string> {
    const auth = deps.outlookAuth();
    if (!auth) throw new MicrosoftAuthError("Outlook is not configured on this brain (set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET).");
    const pkce = pkcePair();
    const state = await deps.connections.issueState(OUTLOOK_CONNECTOR_ID, pkce.verifier);
    return auth.authorizeUrl({ state, codeChallenge: pkce.challenge });
  },

  async complete(deps: Deps, query: URLSearchParams): Promise<ConnectResult> {
    const error = query.get("error");
    if (error) {
      // Only the owner saying no is "cancelled". consent_required (a work tenant needing admin
      // consent), invalid_scope, server_error etc. are failures. Log the code, never error_description.
      if (error === "access_denied") return { code: "cancelled" };
      console.error("[outlook] sign-in returned an error", error.replace(/[^a-z_]/g, "").slice(0, 40));
      return { code: "failed" };
    }
    const code = query.get("code");
    const state = query.get("state");
    if (!code || !state) return { code: "invalid" };

    // Consume the state first, so a replayed callback can't be used even when Outlook isn't configured.
    const codeVerifier = await deps.connections.consumeState(OUTLOOK_CONNECTOR_ID, state);
    if (!codeVerifier) return { code: "expired" };

    const auth = deps.outlookAuth();
    if (!auth) return { code: "failed" };
    try {
      const t = await auth.exchangeCode(code, codeVerifier);
      const allowed = optional("MICROSOFT_ALLOWED_EMAIL");
      let account: string | undefined;
      try {
        account = await auth.readAccount(t.accessToken);
      } catch (err) {
        // Without an allow-list the label is cosmetic; with one we must know who signed in.
        if (allowed) throw err;
        console.warn("[outlook] could not read the account address", (err as Error)?.name);
      }
      if (allowed && account?.toLowerCase() !== allowed.trim().toLowerCase()) {
        return { code: "wrong_account", detail: `This SideKiqq brain only accepts ${allowed}.` };
      }
      await auth.saveConnection(t, deps.clock().toISOString(), account);
      return account ? { code: "connected", account } : { code: "connected" };
    } catch (err) {
      // MicrosoftAuthError messages carry the HTTP status and error code only, never the body or tokens.
      console.error("[outlook] callback failed", err instanceof MicrosoftAuthError ? err.message : (err as Error)?.name);
      return { code: "failed" };
    }
  },
};
