import { withDevice } from "@/lib/auth";
import { HttpError, json, parseJson } from "@/lib/http";
import { AckCommandRequestSchema } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/commands/:id/ack { "result": "opened"|"dismissed"|"failed" } — the target device
 * reports what the owner did. "opened" means the owner tapped and the other app opened; the brain
 * does not learn whether the call was made or the checkout finished, and must not act as if it was.
 */
export const POST = withDevice<{ id: string }>(async (req, { device, deps, params }) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(params.id)) throw new HttpError(404, "no such command", "not_found");
  const { result } = await parseJson(req, AckCommandRequestSchema);
  await deps.repos.commands.ack(params.id, device.id, result);
  return json({ ok: true });
});
