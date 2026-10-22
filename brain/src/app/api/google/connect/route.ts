import { NextResponse } from "next/server";
import { isOwnerSecret } from "@/lib/auth";
import { getDeps } from "@/lib/deps";
import { createOAuthClient, GOOGLE_SCOPES } from "@/lib/google/auth";
import { bearerToken, errorResponse, HttpError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Owner-only: starts Google OAuth. Because this is opened in a browser, the owner secret
 * may be passed as `?secret=` (one-time redirect; the secret is not stored in the URL after).
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const candidate = req.headers.get("x-owner-secret") ?? bearerToken(req) ?? url.searchParams.get("secret");
    if (!isOwnerSecret(candidate)) throw new HttpError(401, "Owner authentication required", "unauthorized");

    const deps = getDeps();
    const state = await deps.googleTokens.issueState();
    const authUrl = createOAuthClient().generateAuthUrl({
      access_type: "offline",
      prompt: "consent", // force a refresh_token every time
      include_granted_scopes: true,
      scope: [...GOOGLE_SCOPES],
      state,
    });
    return NextResponse.redirect(authUrl, { headers: { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
