import { withOwner } from "@/lib/auth";
import { builtInFor } from "@/lib/connectors/requests";
import { HttpError, json, parseJson } from "@/lib/http";
import { ConnectorRequestStatusSchema, CreateConnectorRequestSchema } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Owner-only "request a connector" log (docs/CONNECTOR_REQUESTS.md). Logging a request builds,
 * connects and enables nothing. The build crew builds only `accepted` requests, as a PR.
 *
 * GET  /api/connector-requests?status=<status> → { items: ConnectorRequest[] } (newest first)
 * POST /api/connector-requests { service, purpose, category? } → 201 { request, created } (200 when it was a repeat)
 */
export const GET = withOwner(async (req, { deps }) => {
  const raw = req.nextUrl.searchParams.get("status");
  const parsed = raw === null ? undefined : ConnectorRequestStatusSchema.safeParse(raw);
  if (parsed && !parsed.success) throw new HttpError(400, "unknown status", "invalid");
  const items = await deps.repos.connectorRequests.list(parsed ? { status: parsed.data } : {});
  return json({ items });
});

export const POST = withOwner(async (req, { deps }) => {
  const body = await parseJson(req, CreateConnectorRequestSchema);
  const builtIn = builtInFor(body.service);
  if (builtIn) throw new HttpError(409, `${builtIn} is already supported. Connect it instead of requesting it.`, "already_supported");
  const { request, created } = await deps.repos.connectorRequests.add(body, { kind: "owner" });
  return json({ request, created }, { status: created ? 201 : 200 });
});
