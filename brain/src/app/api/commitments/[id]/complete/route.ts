import { withDevice } from "@/lib/auth";
import { HttpError, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withDevice<{ id: string }>(async (_req, { deps, params }) => {
  const updated = await deps.repos.commitments.complete(params.id);
  if (!updated) throw new HttpError(404, "Commitment not found", "not_found");
  await deps.repos.state.invalidateTop5();
  return json({ ok: true as const });
});
