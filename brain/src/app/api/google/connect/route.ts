import { NextResponse } from "next/server";
import { isOwnerSecret, requireOwner } from "@/lib/auth";
import { getDeps } from "@/lib/deps";
import { config } from "@/lib/env";
import { pkcePair } from "@/lib/crypto";
import { createOAuthClient, GOOGLE_SCOPES, type OAuth2Client } from "@/lib/google/auth";
import { bearerToken, errorResponse, HttpError, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TICKET_TTL_SECONDS = 300;

type CodeChallengeMethod = NonNullable<NonNullable<Parameters<OAuth2Client["generateAuthUrl"]>[0]>["code_challenge_method"]>;

/**
 * Owner-only: mint a one-time browser link for starting Google OAuth.
 * `POST` with `Authorization: Bearer <OWNER_SECRET>` (or `X-Owner-Secret`) returns
 * `{ url, expiresAt }`; open `url` in a browser within 5 minutes. The ticket is single use,
 * so the owner secret itself never appears in a URL or in Vercel's request logs.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    requireOwner(req);
    const ticket = await getDeps().googleTokens.issueConnectTicket(TICKET_TTL_SECONDS);
    const url = new URL("/api/google/connect", config.appUrl());
    url.searchParams.set("ticket", ticket);
    return json(
      { url: url.toString(), expiresAt: new Date(Date.now() + TICKET_TTL_SECONDS * 1000).toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Starts Google OAuth. Auth: owner secret in a header, or a one-time `?ticket=` from POST.
 * `?secret=` is refused: query strings are written to request logs.
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    if (url.searchParams.has("secret")) {
      throw new HttpError(
        400,
        "Passing the owner secret in the URL is not allowed (it gets logged). POST /api/google/connect with the owner secret header to get a one-time link. Consider rotating OWNER_SECRET.",
        "secret_in_url",
      );
    }
    const headerSecret = req.headers.get("x-owner-secret") ?? bearerToken(req);
    const deps = getDeps();
    const ticket = url.searchParams.get("ticket");
    const authorized = isOwnerSecret(headerSecret) || (ticket !== null && (await deps.googleTokens.consumeConnectTicket(ticket)));
    if (!authorized) throw new HttpError(401, "Owner authentication required", "unauthorized");

    // PKCE (docs/CONNECTORS.md §7): the verifier is stored with the single-use state, never sent to the browser.
    const pkce = pkcePair();
    const state = await deps.googleTokens.issueState(pkce.verifier);
    const authUrl = createOAuthClient().generateAuthUrl({
      access_type: "offline",
      prompt: "consent", // force a refresh_token every time
      include_granted_scopes: true,
      scope: [...GOOGLE_SCOPES],
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256" as CodeChallengeMethod,
    });
    return NextResponse.redirect(authUrl, { headers: { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
