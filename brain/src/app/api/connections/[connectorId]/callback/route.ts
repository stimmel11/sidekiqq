import { NextResponse, type NextRequest } from "next/server";
import { getDeps } from "@/lib/deps";
import { config } from "@/lib/env";
import { oauthFlow, type ConnectResultCode } from "@/lib/connectors/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Provider redirect target for the generic flow. No auth header (the provider redirects the
 * browser here); the single-use `state` with its PKCE verifier is the check. Always redirects to
 * the dashboard Connections screen with a result code, never with provider text or tokens.
 * Google's registered redirect URI stays `/api/google/callback` unless GOOGLE_REDIRECT_URI points here.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ connectorId: string }> }): Promise<Response> {
  const { connectorId } = await ctx.params;
  const flow = oauthFlow(connectorId);
  let code: ConnectResultCode = "invalid";
  if (flow) {
    try {
      code = (await flow.complete(getDeps(), new URL(req.url).searchParams)).code;
    } catch (err) {
      console.error(`[connections] ${connectorId.slice(0, 40)} callback failed`, err);
      code = "failed";
    }
  }
  const to = new URL("/dashboard/connections", config.appUrl());
  if (flow) to.searchParams.set("connector", connectorId);
  to.searchParams.set("connect", code);
  return NextResponse.redirect(to, { status: 303, headers: { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" } });
}
