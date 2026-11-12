import type { Deps } from "../../deps";
import { pkcePair } from "../../crypto";
import type { ConnectResult, OAuthFlow } from "../oauth";
import { ZOOM_CONNECTOR_ID, ZoomAuthError } from "./auth";

/**
 * Zoom sign-in for the `zoom` connector behind the generic `/api/connections/zoom/*` routes
 * (docs/CONNECTORS.md §7). Thin wrapper around `ZoomAuth.authorizeUrl` + `exchangeCode`:
 * the single-use `state` and its PKCE verifier live in `ConnectionStore` (10-minute TTL), the
 * refresh token is stored encrypted under connector id "zoom", and nothing here can create a
 * meeting or send anything.
 *
 * Only reachable when Zoom is configured (`ZOOM_CLIENT_ID`/`ZOOM_CLIENT_SECRET`): otherwise the
 * connector isn't registered, so the connect route 404s, and the callback answers `failed`.
 *
 * No account label: reading the Zoom user's email needs an extra scope (`user:read:user`), and the
 * connector asks only for `meeting:write:meeting`.
 */

export const zoomOAuth: OAuthFlow = {
  async authUrl(deps: Deps): Promise<string> {
    const auth = deps.zoomAuth();
    if (!auth) throw new ZoomAuthError("Zoom is not configured on this brain (set ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET).");
    const pkce = pkcePair();
    const state = await deps.connections.issueState(ZOOM_CONNECTOR_ID, pkce.verifier);
    return auth.authorizeUrl({ state, codeChallenge: pkce.challenge });
  },

  async complete(deps: Deps, query: URLSearchParams): Promise<ConnectResult> {
    if (query.get("error")) return { code: "cancelled" };
    const code = query.get("code");
    const state = query.get("state");
    if (!code || !state) return { code: "invalid" };

    // Consume the state first, so a replayed callback can't be used even when Zoom isn't configured.
    const codeVerifier = await deps.connections.consumeState(ZOOM_CONNECTOR_ID, state);
    if (!codeVerifier) return { code: "expired" };

    const auth = deps.zoomAuth();
    if (!auth) return { code: "failed" };
    try {
      await auth.exchangeCode(code, codeVerifier, deps.clock().toISOString());
      return { code: "connected" };
    } catch (err) {
      // ZoomAuthError messages carry the HTTP status and error code only, never the body or tokens.
      console.error("[zoom] callback failed", err instanceof ZoomAuthError ? err.message : (err as Error)?.name);
      return { code: "failed" };
    }
  },

  /** Revokes the grant at Zoom (best effort; `disconnect` has already deleted the stored token). */
  async revoke(secret: string, deps: Deps): Promise<void> {
    const auth = deps.zoomAuth();
    if (!auth) throw new ZoomAuthError("Zoom is not configured on this brain.");
    await auth.revoke(secret);
  },
};
