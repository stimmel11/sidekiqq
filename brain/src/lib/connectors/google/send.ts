import { createHash } from "node:crypto";
import { google } from "googleapis";
import type { OAuth2Client } from "../../google/auth";
import { addressesIn, normalizeAddress } from "../../address";
import type { DraftEnvelope, Workspace } from "../../google/workspace";
import type { Draft } from "../../models";
import type { DraftCheck, DraftExecutor } from "../senders";

/**
 * THE ONLY CODE THAT SENDS GMAIL OR WRITES GOOGLE CALENDAR EVENTS.
 *
 * Registered in the sender registry (../senders.ts) as ("google", "email") and
 * ("google", "calendar_invite"). Only lib/deps.ts
 * imports the registry, and only POST /api/drafts/[id]/approve calls deps.senders().
 * test/no-send.test.ts fails the build if any other module calls a Gmail send method.
 */
export interface MailSender {
  /** Sends an existing Gmail draft. Returns the sent message id. */
  sendDraft(gmailDraftId: string): Promise<{ messageId?: string; threadId?: string }>;
}

export class GmailDraftSender implements MailSender {
  constructor(private readonly auth: OAuth2Client) {}

  async sendDraft(gmailDraftId: string) {
    const gmail = google.gmail({ version: "v1", auth: this.auth });
    const res = await gmail.users.drafts.send({ userId: "me", requestBody: { id: gmailDraftId } });
    return {
      ...(res.data.id ? { messageId: res.data.id } : {}),
      ...(res.data.threadId ? { threadId: res.data.threadId } : {}),
    };
  }
}

/** Sender-registry entry for ("google", "email"). */
export function googleEmailExecutor(workspace: () => Promise<Workspace>, mailer: () => Promise<MailSender>): DraftExecutor {
  const gmailDraftId = (d: Draft): string => {
    if (d.kind !== "email" || !d.providerDraftId) throw new Error("Not a Gmail email draft");
    return d.providerDraftId;
  };
  return {
    check: async (d: Draft): Promise<DraftCheck> => {
      if (d.kind !== "email" || !d.providerDraftId) {
        return { ok: false, reason: "invalid", message: "This draft has no Gmail draft attached, so it can't be sent from here" };
      }
      // The owner may have deleted, sent or edited the draft in Gmail since it was created.
      const env = await (await workspace()).getDraftEnvelope(d.providerDraftId);
      if (!env) return { ok: false, reason: "gone", message: "Draft no longer exists in Gmail" };
      if (!envelopeMatches(d, env)) {
        return { ok: false, reason: "changed", message: "The draft was changed in Gmail since it was read back, so it was not sent. Review it in Gmail" };
      }
      return { ok: true };
    },
    execute: async (d: Draft) => (await mailer()).sendDraft(gmailDraftId(d)),
  };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const addrSet = (values: readonly string[]) => [...new Set(values.flatMap(addressesIn))].sort();
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The Gmail draft still says what the read-back said: the same sorted To and Cc addresses, no
 * Bcc, and the same subject (whitespace-normalised). Anything else → refuse.
 */
export function envelopeMatches(d: Pick<Draft, "to" | "cc" | "subject">, env: DraftEnvelope): boolean {
  return (
    same(addrSet(d.to), addrSet([env.to])) &&
    same(addrSet(d.cc), addrSet([env.cc])) &&
    addrSet([env.bcc]).length === 0 &&
    norm(d.subject) === norm(env.subject)
  );
}

// ---------------------------------------------------------------------------------------
// Calendar invites: THE ONLY CODE THAT WRITES TO GOOGLE CALENDAR.
// ---------------------------------------------------------------------------------------

/** What the invite executor writes. Built from the approved Draft only; nothing else is added. */
export interface InviteEvent {
  /** Deterministic per draft, so a retried approve can't create a second event. */
  eventId: string;
  title: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  attendees: string[];
  /** Add a Google Meet link (Calendar `conferenceData`). */
  meet: boolean;
  /** Idempotency key for the Meet link request. */
  requestId: string;
}

export interface CalendarInviter {
  /** Inserts the event and notifies the attendees. `alreadyExisted`: an earlier attempt created it. */
  insertInvite(e: InviteEvent): Promise<{ eventId: string; alreadyExisted: boolean }>;
}

export class GoogleCalendarInviter implements CalendarInviter {
  constructor(private readonly auth: OAuth2Client) {}

  async insertInvite(e: InviteEvent) {
    const calendar = google.calendar({ version: "v3", auth: this.auth });
    try {
      const res = await calendar.events.insert({
        calendarId: "primary",
        // The owner approved exactly this invite, so Google emails the attendees.
        sendUpdates: "all",
        conferenceDataVersion: e.meet ? 1 : 0,
        requestBody: {
          id: e.eventId,
          summary: e.title,
          ...(e.description ? { description: e.description } : {}),
          ...(e.location ? { location: e.location } : {}),
          start: { dateTime: e.start },
          end: { dateTime: e.end },
          attendees: e.attendees.map((email) => ({ email })),
          // Attendees can't add more people to the owner's meeting.
          guestsCanInviteOthers: false,
          ...(e.meet ? { conferenceData: { createRequest: { requestId: e.requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
        },
      });
      return { eventId: res.data.id ?? e.eventId, alreadyExisted: false };
    } catch (err) {
      // 409: an event with this id exists, i.e. an earlier approve of this same draft created it.
      if ((err as { code?: unknown; status?: unknown })?.code === 409 || (err as { status?: unknown })?.status === 409) {
        return { eventId: e.eventId, alreadyExisted: true };
      }
      throw err;
    }
  }
}

/**
 * Google event id from the draft id: base32hex (a–v, 0–9), 5–1024 chars, per the Calendar API.
 * Same draft → same id, so a second insert after an uncertain failure is a 409, not a second invite.
 */
export function inviteEventId(draftId: string): string {
  const hex = createHash("sha256").update(`sidekiqq-invite:${draftId}`).digest("hex");
  // Hex digits are a subset of base32hex. Prefix keeps it clearly ours.
  return `skq${hex.slice(0, 40)}`;
}

/** Sender-registry entry for ("google", "calendar_invite"). */
export function googleInviteExecutor(inviter: () => Promise<CalendarInviter>, clock: () => Date = () => new Date()): DraftExecutor {
  return {
    check: async (d: Draft): Promise<DraftCheck> => {
      if (d.kind !== "calendar_invite" || !d.when || d.to.length < 1 || d.cc.length > 0 || d.providerDraftId) {
        return { ok: false, reason: "invalid", message: "This draft is not a calendar invite SideKiqq can send" };
      }
      // Records are written with strict addresses; refuse anything else rather than let Google parse it.
      const bad = d.to.filter((a) => normalizeAddress(a) !== a);
      if (bad.length) return { ok: false, reason: "invalid", message: "An attendee is not one plain email address" };
      const start = Date.parse(d.when.start);
      if (!Number.isFinite(start) || start <= clock().getTime()) {
        return { ok: false, reason: "expired", message: "The invite's start time has passed, so it was not sent. Ask for a new invite" };
      }
      return { ok: true };
    },
    execute: async (d: Draft) => {
      if (d.kind !== "calendar_invite" || !d.when) throw new Error("Not a calendar invite draft");
      const created = await (await inviter()).insertInvite({
        eventId: inviteEventId(d.id),
        title: d.subject,
        ...(d.body ? { description: d.body } : {}),
        ...(d.location ? { location: d.location } : {}),
        start: d.when.start,
        end: d.when.end,
        attendees: [...d.to],
        meet: d.conference === "meet",
        requestId: d.id,
      });
      return { messageId: created.eventId };
    },
  };
}
