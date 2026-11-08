import { withDevice } from "@/lib/auth";
import { json } from "@/lib/http";
import { DraftListItemSchema, type Draft } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pending drafts, so a device can show (or read back) what awaits approval (ARCHITECTURE.md).
 * `readback` is the code-built sentence to speak before asking for "send it"; `kind` is "email" or
 * "calendar_invite" (absent on old records = "email"); `when`, `location` and `conference` are set
 * for calendar kinds only. A calendar draft whose start has passed is marked discarded here
 * (lazy expiry, docs/CONNECTORS.md §5) and not listed: it could never be approved.
 */
export const GET = withDevice(async (_req, { deps }) => {
  const now = deps.clock().getTime();
  const listed: Draft[] = [];
  for (const d of await deps.repos.drafts.listPending()) {
    if (d.kind !== "email" && d.when && Date.parse(d.when.start) <= now) {
      await deps.repos.drafts.markDiscarded(d.id).catch(() => undefined);
      continue;
    }
    listed.push(d);
  }
  return json({
    items: listed.map((d) =>
      DraftListItemSchema.parse({
        id: d.id,
        kind: d.kind,
        to: d.to,
        cc: d.cc,
        subject: d.subject,
        body: d.body,
        readback: d.readback,
        ...(d.when ? { when: d.when } : {}),
        ...(d.location !== undefined ? { location: d.location } : {}),
        ...(d.conference ? { conference: d.conference } : {}),
        ...(d.client ? { client: d.client } : {}),
        createdAt: d.createdAt,
      }),
    ),
  });
});
