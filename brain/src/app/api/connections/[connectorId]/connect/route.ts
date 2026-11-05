import { NextResponse, type NextRequest } from "next/server";
import { requireOwnerOrSession } from "@/lib/auth";
import { getDeps } from "@/lib/deps";
import { config } from "@/lib/env";
import { findConnector, startConnect } from "@/lib/connectors/manage";
import { oauthFlow } from "@/lib/connectors/oauth";
import { errorResponse, HttpError, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TICKET_TTL_SECONDS = 300;
type Ctx = { params: Promise<{ connectorId: string }> };

/**
 * Owner only (owner secret header or dashboard session): mint a single-use, 5-minute browser link
 * that starts the provider sign-in. `{ url, expiresAt }`. The owner secret never goes in a URL.
 */
export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  try {
    await requireOwnerOrSession(req);
    const { connectorId } = await ctx.params;
    const deps = getDeps();
    const connector = findConnector(deps, connectorId);
    if (!oauthFlow(connector.id)) throw new HttpError(400, `${connector.displayName} can't be connected from here yet.`, "no_oauth_flow");
    const ticket = await deps.connections.issueConnectTicket(connector.id, TICKET_TTL_SECONDS);
    const url = new URL(`/api/connections/${encodeURIComponent(connector.id)}/connect`, config.appUrl());
    url.searchParams.set("ticket", ticket);
    return json(
      { url: url.toString(), expiresAt: new Date(deps.clock().getTime() + TICKET_TTL_SECONDS * 1000).toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/** Opens the provider sign-in. Auth: a one-time `?ticket=` from POST. `?secret=` is refused (URLs get logged). */
export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  try {
    const url = new URL(req.url);
    if (url.searchParams.has("secret")) {
      throw new HttpError(400, "Passing the owner secret in the URL is not allowed (it gets logged). POST to this path for a one-time link.", "secret_in_url");
    }
    const { connectorId } = await ctx.params;
    const deps = getDeps();
    const connector = findConnector(deps, connectorId);
    const ticket = url.searchParams.get("ticket");
    if (!ticket || !(await deps.connections.consumeConnectTicket(connector.id, ticket))) {
      throw new HttpError(401, "This link expired or was already used. Start again from Connections.", "unauthorized");
    }
    const authUrl = await startConnect(deps, connector.id);
    return NextResponse.redirect(authUrl, { headers: { "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
