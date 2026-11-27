import type { Deps } from "../../deps";
import { pkcePair } from "../../crypto";
import type { ConnectResult, OAuthFlow } from "../oauth";
import { KROGER_CONNECTOR_ID, KrogerSignInError } from "./auth";

/**
 * Kroger / King Soopers sign-in for the `kroger` connector behind the generic
 * `/api/connections/kroger/*` routes (docs/CONNECTORS.md §7). Thin wrapper around
 * `KrogerAuth.authorizeUrl` + `exchangeCode`: the single-use `state` and its PKCE verifier live in
 * `ConnectionStore` (10-minute TTL), the refresh token is stored encrypted under connector id
 * "kroger", and nothing here can search, touch the cart or place an order.
 *
 * Only reachable when Kroger is configured (`KROGER_CLIENT_ID`/`KROGER_CLIENT_SECRET`): otherwise
 * the connector isn't registered, so the connect route 404s, and the callback answers `failed`.
 *
 * No account label (that needs Kroger's `profile.compact` scope, which we don't ask for) and no
 * `revoke`: Kroger documents no revoke endpoint, so disconnect only deletes the stored token. The
 * owner removes the grant on Kroger's site if they want it gone there too.
 */

export const krogerOAuth: OAuthFlow = {
  async authUrl(deps: Deps): Promise<string> {
    const auth = deps.krogerAuth();
    if (!auth) throw new KrogerSignInError("Kroger is not configured on this brain (set KROGER_CLIENT_ID and KROGER_CLIENT_SECRET).");
    const pkce = pkcePair();
    const state = await deps.connections.issueState(KROGER_CONNECTOR_ID, pkce.verifier);
    return auth.authorizeUrl({ state, codeChallenge: pkce.challenge });
  },

  async complete(deps: Deps, query: URLSearchParams): Promise<ConnectResult> {
    if (query.get("error")) return { code: "cancelled" };
    const code = query.get("code");
    const state = query.get("state");
    if (!code || !state) return { code: "invalid" };

    // Consume the state first, so a replayed callback can't be used even when Kroger isn't configured.
    const codeVerifier = await deps.connections.consumeState(KROGER_CONNECTOR_ID, state);
    if (!codeVerifier) return { code: "expired" };

    const auth = deps.krogerAuth();
    if (!auth) return { code: "failed" };
    try {
      await auth.exchangeCode(code, codeVerifier, deps.clock().toISOString());
      return { code: "connected" };
    } catch (err) {
      // KrogerSignInError messages carry the HTTP status and error code only, never the body or tokens.
      // A missing refresh token is "failed" too: the `no_refresh_token` text is Google-specific.
      console.error("[kroger] callback failed", err instanceof KrogerSignInError ? err.message : (err as Error)?.name);
      return { code: "failed" };
    }
  },
};
