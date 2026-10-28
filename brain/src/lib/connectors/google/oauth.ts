import { google } from "googleapis";
import type { Deps } from "../../deps";
import { pkcePair } from "../../crypto";
import { optional } from "../../env";
import { createOAuthClient, GOOGLE_SCOPES, type OAuth2Client } from "../../google/auth";
import type { ConnectResult, OAuthFlow } from "../oauth";

/**
 * Google sign-in for the `google` connector, shared by `/api/google/{connect,callback}` and the
 * generic `/api/connections/google/*` routes (docs/CONNECTORS.md §7, §8 step 3). The redirect URI
 * is unchanged (`GOOGLE_REDIRECT_URI`, default `/api/google/callback`), so no Google Cloud change
 * is needed. PKCE on every flow; the verifier stays server-side with the single-use state.
 */

type CodeChallengeMethod = NonNullable<NonNullable<Parameters<OAuth2Client["generateAuthUrl"]>[0]>["code_challenge_method"]>;

export const googleOAuth: OAuthFlow = {
  async authUrl(deps: Deps): Promise<string> {
    const pkce = pkcePair();
    const state = await deps.googleTokens.issueState(pkce.verifier);
    return createOAuthClient().generateAuthUrl({
      access_type: "offline",
      prompt: "consent", // force a refresh_token every time
      include_granted_scopes: true,
      scope: [...GOOGLE_SCOPES],
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256" as CodeChallengeMethod,
    });
  },

  async complete(deps: Deps, query: URLSearchParams): Promise<ConnectResult> {
    const error = query.get("error");
    if (error) return { code: "cancelled", detail: `Google returned: ${error.slice(0, 100)}` };
    const code = query.get("code");
    const state = query.get("state");
    if (!code || !state) return { code: "invalid" };

    const codeVerifier = await deps.googleTokens.consumeState(state);
    if (!codeVerifier) return { code: "expired" };

    try {
      const client = createOAuthClient();
      const { tokens } = await client.getToken({ code, codeVerifier });
      let refreshToken = tokens.refresh_token ?? undefined;
      if (!refreshToken) refreshToken = (await deps.googleTokens.load())?.refreshToken;
      if (!refreshToken) return { code: "no_refresh_token" };
      client.setCredentials(tokens);
      const profile = await google.gmail({ version: "v1", auth: client }).users.getProfile({ userId: "me" });
      const email = profile.data.emailAddress ?? undefined;

      const allowed = optional("GOOGLE_ALLOWED_EMAIL");
      if (allowed && email?.toLowerCase() !== allowed.toLowerCase()) {
        return { code: "wrong_account", detail: `This SideKiqq brain only accepts ${allowed}.` };
      }

      await deps.googleTokens.save({
        refreshToken,
        ...(email ? { email } : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
        connectedAt: deps.clock().toISOString(),
      });
      return { code: "connected", ...(email ? { account: email } : {}) };
    } catch (err) {
      console.error("[google] callback failed", err);
      return { code: "failed" };
    }
  },

  /** Revokes the grant at Google (a refresh token revokes the whole grant). */
  async revoke(secret: string): Promise<void> {
    await createOAuthClient().revokeToken(secret);
  },
};
