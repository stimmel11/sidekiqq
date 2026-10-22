import { withDevice } from "@/lib/auth";
import { HttpError, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Extension: mark a draft discarded so it stops appearing as pending. Never sends. (Gmail copy is left for the owner.) */
export const POST = withDevice<{ id: string }>(async (_req, { deps, params }) => {
  const draft = await deps.repos.drafts.get(params.id);
  if (!draft) throw new HttpError(404, "Draft not found", "not_found");
  if (draft.status !== "pending") throw new HttpError(409, `Draft is ${draft.status}, not pending`, "not_pending");
  await deps.repos.drafts.markDiscarded(draft.id);
  await deps.repos.state.invalidateTop5();
  return json({ ok: true as const });
});
