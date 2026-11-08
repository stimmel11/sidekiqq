import type { Deps } from "../deps";
import { truncate } from "../util";
import { CalendarInvitePrepareInput, OWNER_INITIATED, POLICY, type CalendarInvitePrepareIn, type PrepareOutput } from "./capabilities";
import { connectorFor } from "./invoke";
import { buildReadback, READBACK_MAX_CHARS, ReadbackTooLongError } from "./readback";
import { effectiveCapabilities } from "./store";
import { CapabilityDeniedError, CapabilityUnavailableError, ConnectionUnusableError, type ConnCtx } from "./types";

/**
 * THE PREPARE PATH for `confirm`-tier capabilities (docs/CONNECTORS.md §2, §5).
 *
 * A prepare call writes ONE pending Draft record with its code-built read-back and nothing else:
 * no provider call, no calendar write, nobody notified. `invokeCapability` still refuses every
 * confirm-tier capability; this is the only way to make one, and only POST /api/drafts/:id/approve
 * can execute the Draft (sender registry, `google:calendar_invite`).
 *
 * Rules, in order:
 *  1. Owner-initiated callers only (ask, task, dashboard). Background callers never prepare.
 *  2. A connector must offer the capability (Google today).
 *  3. Its stored connection must be usable: not `needs_reauth`, the capability enabled by the owner
 *     and its scope (`calendar.events`) granted. A legacy record without granted scopes passes, as
 *     in invokeCapability; the executor then fails at approve time and nothing is sent.
 *  4. Input is validated (strict bare attendee addresses, end after start, max length) and the
 *     start must be in the future (and within a year) by the brain's clock.
 *  5. The read-back must fit one /api/speak call; longer is refused, never truncated.
 *  6. Every attempt that passes rule 2 writes an audit row (body redacted: only title, time and
 *     attendee count).
 */

/** An invite may start no earlier than this from now (the owner still has to hear it and approve). */
export const INVITE_MIN_LEAD_MS = 60_000;
export const INVITE_MAX_AHEAD_MS = 366 * 86_400_000;

export async function prepareCalendarInvite(deps: Deps, input: unknown, ctx: ConnCtx): Promise<PrepareOutput> {
  const cap = "calendar.invite.prepare" as const;
  if (!OWNER_INITIATED.includes(ctx.caller)) throw new CapabilityDeniedError(cap, `not allowed for background caller "${ctx.caller}"`);

  const connector = connectorFor(deps.connectors(), cap);
  if (!connector) throw new CapabilityUnavailableError(cap);

  const stored = await deps.connections.load(connector.id);
  if (stored) {
    if (stored.status === "needs_reauth") {
      throw new ConnectionUnusableError(cap, connector.id, "needs_reauth", `${connector.displayName} needs to be reconnected before SideKiqq can use it. Ask the owner to reconnect it.`);
    }
    if (!effectiveCapabilities(connector, stored).includes(cap)) {
      throw new ConnectionUnusableError(
        cap,
        connector.id,
        "disabled",
        `Calendar invites are turned off for ${connector.displayName}, or the calendar permission was not granted. The owner can turn it on by reconnecting Google from Connections.`,
      );
    }
  }

  const audit = async (ok: boolean, summary: string, error?: string) => {
    await deps.repos.audit
      .add({
        connector: connector.id,
        capability: cap,
        tier: POLICY[cap],
        caller: ctx.caller,
        ...(ctx.device ? { device: ctx.device } : {}),
        summary: truncate(summary, 300),
        ok,
        ...(error ? { error: truncate(error, 300) } : {}),
      })
      .catch((err: unknown) => console.warn("[audit] write failed", err));
  };

  const parsed = CalendarInvitePrepareInput.safeParse(input);
  if (!parsed.success) {
    const message = `invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`;
    await audit(false, "invite (invalid input)", message);
    throw new CapabilityDeniedError(cap, message);
  }
  const i: CalendarInvitePrepareIn = parsed.data;
  const start = new Date(i.start);
  const end = new Date(i.end);
  const summary = `invite "${i.title}" ${start.toISOString()} → ${end.toISOString()}, ${i.attendees.length} attendee(s)${i.conference ? `, ${i.conference}` : ""}`;

  const refuse = async (message: string): Promise<never> => {
    await audit(false, summary, message);
    throw new CapabilityDeniedError(cap, message);
  };
  const now = deps.clock().getTime();
  if (start.getTime() < now + INVITE_MIN_LEAD_MS) await refuse("the start time has passed or is less than a minute away");
  if (start.getTime() > now + INVITE_MAX_AHEAD_MS) await refuse("the start time is more than a year away");

  const when = { start: start.toISOString(), end: end.toISOString() };
  const rb = buildReadback({ kind: "calendar_invite", to: i.attendees, subject: i.title, when, ...(i.conference ? { conference: i.conference } : {}) });
  if (rb.length > READBACK_MAX_CHARS) await refuse(new ReadbackTooLongError(rb.length).message);

  try {
    const draft = await deps.repos.drafts.create({
      kind: "calendar_invite",
      connectorId: connector.id,
      to: i.attendees,
      cc: [],
      subject: i.title,
      body: i.body ?? "",
      when,
      ...(i.location ? { location: i.location } : {}),
      ...(i.conference ? { conference: i.conference } : {}),
      ...(i.client ? { client: i.client } : {}),
    });
    await audit(true, summary);
    return { draftId: draft.id, readback: draft.readback };
  } catch (err) {
    await audit(false, summary, (err as Error)?.message ?? String(err));
    throw err;
  }
}
