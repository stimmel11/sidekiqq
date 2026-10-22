import { withDevice } from "@/lib/auth";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Extension (not in the core contract table): pending drafts so a device can show what awaits approval. */
export const GET = withDevice(async (_req, { deps }) => {
  const drafts = await deps.repos.drafts.listPending();
  return json({
    items: drafts.map((d) => ({ id: d.id, to: d.to, cc: d.cc, subject: d.subject, body: d.body, client: d.client, createdAt: d.createdAt })),
  });
});
