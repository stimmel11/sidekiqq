import { withDevice } from "@/lib/auth";
import { HttpError, json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * THE ONLY ROUTE THAT SENDS EMAIL (see ARCHITECTURE.md safety rules and test/no-send.test.ts).
 * Devices call this only after an explicit owner confirmation.
 *
 * Guards, in order:
 *  1. Authenticated device (withDevice).
 *  2. Draft exists in our store and is still "pending" (not sent/discarded).
 *  3. Per-draft lock so a double-tap cannot send twice.
 *  4. A sender is registered for the draft's (connectorId, kind) (else 422 unsupported_kind).
 *  5. The sender's check passes. For Gmail: the draft still exists (else 410 gone) and its To, Cc,
 *     Bcc and Subject still match what the read-back described (else 409 changed_in_provider);
 *     a record with no Gmail draft id is 422 no_provider_draft.
 */
export const POST = withDevice<{ id: string }>(async (_req, { deps, params, device }) => {
  const { drafts, followups, timeline, state } = deps.repos;

  const draft = await drafts.get(params.id);
  if (!draft) throw new HttpError(404, "Draft not found", "not_found");
  if (draft.status !== "pending") throw new HttpError(409, `Draft is ${draft.status}, not pending`, "not_pending");

  if (!(await drafts.acquireSendLock(draft.id))) throw new HttpError(409, "Draft is already being sent", "in_progress");
  try {
    // Re-read under the lock to close the check-then-act window.
    const fresh = await drafts.get(draft.id);
    if (!fresh || fresh.status !== "pending") throw new HttpError(409, "Draft is no longer pending", "not_pending");

    // The sender registry is the only place that can execute a draft (docs/CONNECTORS.md §6).
    const registry = deps.senders();
    // No executor for this (connectorId, kind), e.g. a calendar draft before the calendar item
    // ships. Nothing is sent and the draft stays pending.
    if (!registry.has(fresh)) throw new HttpError(422, `This ${fresh.kind.replace("_", " ")} draft can't be approved yet`, "unsupported_kind");
    const executor = registry.for(fresh);
    const check = await executor.check(fresh);
    if (!check.ok) {
      if (check.reason === "invalid") throw new HttpError(422, check.message, "no_provider_draft");
      // Gone or changed in the provider: the stored read-back no longer describes what would be
      // sent, so the record is retired and nothing is sent.
      await drafts.markDiscarded(fresh.id);
      if (check.reason === "changed") throw new HttpError(409, check.message, "changed_in_provider");
      throw new HttpError(410, check.message, "gone");
    }

    const sent = await executor.execute(fresh);
    await drafts.markSent(fresh.id, sent.messageId);

    if (fresh.followupId) await followups.resolve(fresh.followupId).catch(() => undefined);
    await timeline
      .add({
        ...(fresh.client ? { client: fresh.client } : {}),
        event: `Email sent to ${fresh.to.join(", ")}: "${fresh.subject}" (approved on ${device.kind})`,
        people: fresh.to,
        categories: ["Follow-Up"],
        importance: "LOW",
        source: { kind: "email", ...(sent.messageId ? { ref: sent.messageId } : {}) },
      })
      .catch(() => undefined);
    await state.invalidateTop5().catch(() => undefined);
    return json({ ok: true as const });
  } finally {
    await drafts.releaseSendLock(draft.id);
  }
});
