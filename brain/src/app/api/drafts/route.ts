import { withDevice } from "@/lib/auth";
import { json } from "@/lib/http";
import { DraftListItemSchema } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pending drafts, so a device can show (or read back) what awaits approval (ARCHITECTURE.md).
 * `readback` is the code-built sentence to speak before asking for "send it"; `kind` is "email"
 * for every draft today (absent on old records = "email"); `when` is set for calendar kinds only.
 */
export const GET = withDevice(async (_req, { deps }) => {
  const drafts = await deps.repos.drafts.listPending();
  return json({
    items: drafts.map((d) =>
      DraftListItemSchema.parse({
        id: d.id,
        kind: d.kind,
        to: d.to,
        cc: d.cc,
        subject: d.subject,
        body: d.body,
        readback: d.readback,
        ...(d.when ? { when: d.when } : {}),
        ...(d.client ? { client: d.client } : {}),
        createdAt: d.createdAt,
      }),
    ),
  });
});
