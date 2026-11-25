import { createHash } from "node:crypto";
import { google } from "googleapis";
import type { OAuth2Client } from "../../google/auth";
import { addressesIn, normalizeAddress } from "../../address";
import type { DraftEnvelope, Workspace } from "../../google/workspace";
import type { Draft } from "../../models";
import { VIDEO_ROOM_MAX_MINUTES, type VideoRoom } from "../capabilities";
import type { DraftCheck, DraftExecutor } from "../senders";
import { CapabilityDeniedError, CapabilityUnavailableError, ConnectionUnusableError, ProviderRefusedError, ReauthRequiredError } from "../types";
import { ZoomApiError } from "../zoom/errors";

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
  /**
   * Inserts the event and notifies the attendees. `alreadyExisted`: an earlier attempt created it.
   * `meetLink`: false when a Meet link was asked for but Google didn't create one.
   * Throws ProviderRefusedError on a definite refusal (4xx other than 409).
   */
  insertInvite(e: InviteEvent): Promise<{ eventId: string; alreadyExisted: boolean; meetLink?: boolean }>;
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
      // Google can still create the event (and email everyone) when it can't make the Meet link,
      // e.g. Meet turned off by a Workspace admin: report that rather than claim a link.
      const meetLink = e.meet ? Boolean(res.data.hangoutLink) || res.data.conferenceData?.createRequest?.status?.statusCode === "pending" : undefined;
      return { eventId: res.data.id ?? e.eventId, alreadyExisted: false, ...(meetLink === undefined ? {} : { meetLink }) };
    } catch (err) {
      const status = httpStatus(err);
      // 409: an event with this id exists, i.e. an earlier approve of this same draft created it.
      // (Ids of deleted events stay reserved too; then no event exists, which the owner can see.)
      if (status === 409) return { eventId: e.eventId, alreadyExisted: true };
      // Any other 4xx: Google refused it, so nothing was created or sent.
      if (status !== undefined && status >= 400 && status < 500) {
        throw new ProviderRefusedError(status === 403 || status === 401 ? "Google refused the invite: SideKiqq lacks calendar permission. Reconnect Google from Connections." : `Google refused the invite (HTTP ${status}). Nothing was sent.`);
      }
      throw err;
    }
  }
}

/** HTTP status of a googleapis (gaxios) error: `status` (gaxios 7+), `code` or `response.status`. */
function httpStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } } | null;
  for (const v of [e?.status, e?.response?.status, e?.code]) if (typeof v === "number") return v;
  return undefined;
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

/**
 * Zoom rooms for `conference: "zoom"` invites. `create` goes through invokeCapability
 * ("video.create_room": fixed no-invite body, connection/switch checks, audit), wired in lib/deps.ts.
 * `save` stores the room on the draft (DraftsRepo.setVideoRoom) BEFORE the event is written.
 */
export interface InviteVideoRooms {
  create(input: { topic: string; start: string; durationMin: number }): Promise<VideoRoom>;
  save(draftId: string, room: NonNullable<Draft["videoRoom"]>): Promise<boolean>;
}

/** Zoom's room length for an invite: the event's length in minutes, within video.create_room's limits. */
export function zoomRoomMinutes(when: { start: string; end: string }): number {
  const min = Math.round((Date.parse(when.end) - Date.parse(when.start)) / 60_000);
  return Math.min(VIDEO_ROOM_MAX_MINUTES, Math.max(5, Number.isFinite(min) ? min : 30));
}

/** The join text appended to the event description. Only what Zoom returned: link, id, passcode. */
export function zoomJoinText(room: NonNullable<Draft["videoRoom"]>): string {
  return [`Join Zoom meeting: ${room.joinUrl}`, `Meeting ID: ${room.meetingId}`, ...(room.passcode ? [`Passcode: ${room.passcode}`] : [])].join("\n");
}

/**
 * Any failure while making the Zoom room happens BEFORE the event write, so nothing was sent:
 * always a ProviderRefusedError (422, draft stays pending). Fixed messages, never provider text
 * beyond ZoomApiError's own (which is ours too).
 */
function zoomRefusal(err: unknown): ProviderRefusedError {
  const tail = " The invite was not sent.";
  if (err instanceof ZoomApiError) return new ProviderRefusedError(`${err.message}${tail}`);
  if (err instanceof ReauthRequiredError) return new ProviderRefusedError(`Zoom needs to be reconnected from Connections.${tail}`);
  if (err instanceof ConnectionUnusableError) {
    return new ProviderRefusedError(err.reason === "needs_reauth" ? `Zoom needs to be reconnected from Connections.${tail}` : `Zoom rooms are turned off in Connections.${tail}`);
  }
  if (err instanceof CapabilityUnavailableError) return new ProviderRefusedError(`Zoom isn't set up on this SideKiqq.${tail}`);
  if (err instanceof CapabilityDeniedError) return new ProviderRefusedError(`Zoom isn't connected, or SideKiqq couldn't make the room.${tail}`);
  return new ProviderRefusedError(`SideKiqq couldn't make the Zoom room.${tail}`);
}

/** Sender-registry entry for ("google", "calendar_invite"). */
export function googleInviteExecutor(inviter: () => Promise<CalendarInviter>, clock: () => Date = () => new Date(), rooms?: InviteVideoRooms): DraftExecutor {
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
      // Zoom: reuse the room an earlier attempt saved, else make one and save it before the event
      // write, so a retried approve never makes a second room. No room → no event, nothing sent.
      let room = d.conference === "zoom" ? d.videoRoom : undefined;
      if (d.conference === "zoom" && !room) {
        if (!rooms) throw new ProviderRefusedError("Zoom isn't set up on this SideKiqq. The invite was not sent.");
        let made: VideoRoom;
        try {
          made = await rooms.create({ topic: d.subject, start: d.when.start, durationMin: zoomRoomMinutes(d.when) });
        } catch (err) {
          throw zoomRefusal(err);
        }
        room = { provider: "zoom", meetingId: made.meetingId, joinUrl: made.joinUrl, ...(made.passcode ? { passcode: made.passcode } : {}) };
        if (!(await rooms.save(d.id, room))) throw new Error("Could not save the Zoom room on the invite draft; nothing was sent");
      }
      const description = [d.body, room ? zoomJoinText(room) : ""].filter(Boolean).join("\n\n");
      const location = d.location ?? room?.joinUrl;
      const created = await (await inviter()).insertInvite({
        eventId: inviteEventId(d.id),
        title: d.subject,
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        start: d.when.start,
        end: d.when.end,
        attendees: [...d.to],
        meet: d.conference === "meet",
        requestId: d.id,
      });
      return {
        messageId: created.eventId,
        ...(created.meetLink === false ? { warning: "Google didn't add a Meet link, so the invite went out without one." } : {}),
      };
    },
  };
}
