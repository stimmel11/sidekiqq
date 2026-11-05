import { withOwner } from "@/lib/auth";
import { HttpError, json, parseJson } from "@/lib/http";
import { UpdateConnectorRequestSchema } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/connector-requests/:id { status?, prUrl?, note? } → { request }. Owner bookkeeping only:
 * marking a request `live` records that the owner merged the PR; it does not connect or enable anything.
 */
export const PATCH = withOwner<{ id: string }>(async (req, { deps, params }) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(params.id)) throw new HttpError(404, "no such connector request", "not_found");
  const patch = await parseJson(req, UpdateConnectorRequestSchema);
  const request = await deps.repos.connectorRequests.update(params.id, patch);
  return json({ request });
});
