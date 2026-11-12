import { z } from "zod";
import { ADDRESS_MAX, normalizeAddress } from "../address";
import type { CalendarEvent, DriveFile, EmailMessage, EmailSummary } from "../google/workspace";
import type { ContactLookup } from "../google/contacts";
import { CONTACT_NAME_MAX_CHARS, CONTACT_NAME_RE, CONTACTS_MAX } from "../google/contacts-rules";

/**
 * Capability interfaces (docs/CONNECTORS.md §2).
 *
 * Claude's tools, the cron scanner and the briefing are written against these capabilities, never
 * against a provider. Every call goes through `invokeCapability` (./invoke.ts), which applies the
 * fixed POLICY table below.
 *
 * Executors (`email.send`, the calendar invite/hold executors) are deliberately NOT capabilities:
 * they exist only in the sender registry (./senders.ts), which only the approve route reaches.
 */

export type Tier = "auto" | "confirm" | "user_finishes";

/** Who is calling. Only owner-initiated callers may run auto writes or create handoffs (§4.4). */
export type Caller = "ask" | "task" | "brief" | "cron" | "dashboard";
export const OWNER_INITIATED: readonly Caller[] = ["ask", "task", "dashboard"];

/**
 * The full, closed list of callable capabilities and their tiers. Fixed in code; owner overrides
 * are not in v1. Adding an entry here is a design change: update docs/CONNECTORS.md first.
 */
export const POLICY = {
  "email.read": "auto",
  "email.draft": "auto",
  "contacts.lookup": "auto",
  "calendar.read": "auto",
  "calendar.hold.prepare": "confirm",
  "calendar.invite.prepare": "confirm",
  "files.read": "auto",
  "video.create_room": "auto",
  "grocery.search": "auto",
  "grocery.cart.add": "auto",
  "grocery.checkout": "user_finishes",
  "device.call": "user_finishes",
  "device.open_url": "user_finishes",
} as const satisfies Record<string, Tier>;

export type CapabilityId = keyof typeof POLICY;
export const CAPABILITY_IDS = Object.keys(POLICY) as CapabilityId[];

/** Read-only capabilities that the cron scan and the briefing may use. Everything else fails closed for them. */
export const BACKGROUND_ALLOWED: readonly CapabilityId[] = ["email.read", "calendar.read", "contacts.lookup"];

/** Reads: never write anything anywhere. Every other auto capability is an "auto write". */
export const READ_ONLY: readonly CapabilityId[] = ["email.read", "contacts.lookup", "calendar.read", "files.read", "grocery.search"];

export function isCapabilityId(x: string): x is CapabilityId {
  return Object.prototype.hasOwnProperty.call(POLICY, x);
}

// ---------------------------------------------------------------------------------------
// Input schemas for the capabilities implemented so far. Inputs are validated by
// invokeCapability before any connector sees them.
// ---------------------------------------------------------------------------------------

const id = z.string().trim().min(1).max(200);

export const EmailReadInput = z.discriminatedUnion("op", [
  z.object({ op: z.literal("search"), query: z.string().trim().min(1).max(500), max: z.number().int().min(1).max(25) }),
  /** Ids only, for the cron scanner's cursoring. Larger cap because it fetches no content. */
  z.object({ op: z.literal("list_ids"), query: z.string().trim().min(1).max(500), max: z.number().int().min(1).max(500) }),
  z.object({ op: z.literal("thread"), threadId: id }),
  z.object({ op: z.literal("message"), id }),
  /** The connected account's own address. */
  z.object({ op: z.literal("account") }),
]);

/**
 * One bare ASCII address, normalised (lib/address.ts). The connector, the Draft record and the
 * read-back all get this same normalised list, so they can't disagree about who receives it.
 */
const address = z
  .string()
  .max(ADDRESS_MAX + 2)
  .transform((s, ctx) => {
    const a = normalizeAddress(s);
    if (a === null) {
      ctx.addIssue({ code: "custom", message: "must be one plain email address (name@example.com): no names, lists or non-ASCII" });
      return z.NEVER;
    }
    return a;
  });

/**
 * Recipient caps. With 254-character addresses the read-back could still pass READBACK_MAX_CHARS;
 * that case is refused before any provider draft is made (invokeCapability), never truncated.
 */
export const EMAIL_TO_MAX = 5;
export const EMAIL_CC_MAX = 5;

export const EmailDraftInput = z.object({
  to: z.array(address).min(1).max(EMAIL_TO_MAX),
  cc: z.array(address).max(EMAIL_CC_MAX).optional(),
  subject: z.string().trim().min(1).max(250),
  body: z.string().trim().min(1).max(20_000),
  threadId: id.optional(),
  /** SideKiqq bookkeeping stored on the Draft record only; never sent to the provider. */
  client: z.string().trim().min(1).max(200).optional(),
  followupId: z.string().trim().min(1).max(100).optional(),
});

export const CalendarReadInput = z.object({
  timeMin: z.iso.datetime({ offset: true }),
  timeMax: z.iso.datetime({ offset: true }),
  query: z.string().trim().min(1).max(200).optional(),
  max: z.number().int().min(1).max(50),
});

export const FilesReadInput = z.object({
  query: z.string().trim().min(1).max(200),
  max: z.number().int().min(1).max(10),
  includeContent: z.boolean(),
});

/** Name to resolve: letters, spaces and . ' - only (same rules the provider module applies). */
export const ContactsLookupInput = z.object({
  name: z.string().trim().min(1).max(CONTACT_NAME_MAX_CHARS).regex(CONTACT_NAME_RE, "a contact name can only contain letters, spaces, and . ' -"),
  max: z.number().int().min(1).max(CONTACTS_MAX),
});

/**
 * `video.create_room` (Zoom only, auto): an unannounced room for the owner to open. No invitees,
 * attendees or emails in the input at all; the connector hard-codes the rest of the request.
 * No `start` = an instant meeting.
 */
export const VIDEO_ROOM_MAX_MINUTES = 240;
export const VideoCreateRoomInput = z.object({
  topic: z.string().trim().min(1).max(200),
  start: z.iso.datetime({ offset: true }).optional(),
  durationMin: z.number().int().min(5).max(VIDEO_ROOM_MAX_MINUTES).optional(),
});

/**
 * `calendar.invite.prepare` (confirm): PREPARES an invite as a pending Draft. Nothing is written to
 * any calendar and nobody is notified until the owner approves it (POST /api/drafts/:id/approve,
 * executor `google:calendar_invite` in the sender registry). Attendees are strict bare addresses,
 * like email recipients. `conference: "meet"` adds a Google Meet link at execute time; Zoom in
 * invites is a later slice. Time rules (future start, max length) are checked by the prepare path
 * against the clock, and again at approve time.
 */
export const INVITE_ATTENDEES_MAX = 10;
export const INVITE_MAX_MINUTES = 12 * 60;
export const INVITE_CONFERENCES = ["meet"] as const;
export const CalendarInvitePrepareInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    attendees: z.array(address).min(1).max(INVITE_ATTENDEES_MAX),
    location: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(5_000).optional(),
    conference: z.enum(INVITE_CONFERENCES).optional(),
    client: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((i, ctx) => {
    const s = Date.parse(i.start);
    const e = Date.parse(i.end);
    if (!(e > s)) ctx.addIssue({ code: "custom", message: "end must be after start", path: ["end"] });
    else if (e - s > INVITE_MAX_MINUTES * 60_000) ctx.addIssue({ code: "custom", message: `an invite can be at most ${INVITE_MAX_MINUTES / 60} hours long`, path: ["end"] });
    if (new Set(i.attendees).size !== i.attendees.length) ctx.addIssue({ code: "custom", message: "each attendee once", path: ["attendees"] });
  });
export type CalendarInvitePrepareIn = z.infer<typeof CalendarInvitePrepareInput>;

/** What a prepare-tier capability returns: the pending Draft and its code-built read-back. Nothing was sent. */
export interface PrepareOutput {
  draftId: string;
  readback: string;
}

/** Never the host `start_url` (it carries a host token). */
export interface VideoRoom {
  meetingId: string;
  joinUrl: string;
  passcode?: string;
  /** Scheduled start (UTC ISO) when one was given; absent for instant rooms. */
  start?: string;
}

export type EmailReadIn = z.infer<typeof EmailReadInput>;
export type EmailReadOutput<I extends EmailReadIn> = I extends { op: "search" }
  ? EmailSummary[]
  : I extends { op: "list_ids" }
    ? { id: string; threadId: string }[]
    : I extends { op: "thread" }
      ? EmailMessage[]
      : I extends { op: "message" }
        ? EmailMessage
        : I extends { op: "account" }
          ? { email?: string }
          : never;

/** What a connector returns for `email.draft`: the draft it created in the provider. */
export interface EmailDraftProviderOutput {
  providerDraftId: string;
  threadId?: string;
}

/**
 * What `email.draft` returns to its caller (§2): the pending Draft record that invokeCapability
 * created, and its code-built read-back. Creating a draft sends nothing.
 */
export interface EmailDraftOutput {
  draftId: string;
  providerDraftId?: string;
  readback: string;
}

/**
 * Input/output types per implemented capability. Unimplemented ones map to `never` until built.
 * `provider` is what `Connector.invoke` returns when invokeCapability post-processes it (only
 * `email.draft` today: it adds the Draft record); otherwise it equals `out`.
 */
export interface CapabilityIO {
  "email.read": { in: EmailReadIn; out: EmailReadOutput<EmailReadIn>; provider: EmailReadOutput<EmailReadIn> };
  "email.draft": { in: z.infer<typeof EmailDraftInput>; out: EmailDraftOutput; provider: EmailDraftProviderOutput };
  "calendar.read": { in: z.infer<typeof CalendarReadInput>; out: CalendarEvent[]; provider: CalendarEvent[] };
  "files.read": { in: z.infer<typeof FilesReadInput>; out: DriveFile[]; provider: DriveFile[] };
  "contacts.lookup": { in: z.infer<typeof ContactsLookupInput>; out: ContactLookup; provider: ContactLookup };
  "video.create_room": { in: z.infer<typeof VideoCreateRoomInput>; out: VideoRoom; provider: VideoRoom };
}
export type ImplementedCapability = keyof CapabilityIO;
export type In<C extends ImplementedCapability> = CapabilityIO[C]["in"];
export type Out<C extends ImplementedCapability> = CapabilityIO[C]["out"];
/** What a connector's `invoke` returns for capability C. */
export type ProviderOut<C extends ImplementedCapability> = CapabilityIO[C]["provider"];

export const INPUT_SCHEMAS: { [C in ImplementedCapability]: z.ZodType<In<C>> } = {
  "email.read": EmailReadInput,
  "email.draft": EmailDraftInput,
  "calendar.read": CalendarReadInput,
  "files.read": FilesReadInput,
  "contacts.lookup": ContactsLookupInput,
  "video.create_room": VideoCreateRoomInput,
};

/** Plain words for the owner (Connections screen). */
export const TIER_LABEL: Record<Tier, string> = {
  auto: "reads automatically",
  confirm: "asks you first",
  user_finishes: "you finish on your phone",
};

/** What each capability does, in plain words (Connections screen). None of them sends anything. */
export const CAPABILITY_LABEL: Record<CapabilityId, string> = {
  "email.read": "Read and search your email",
  "email.draft": "Write email drafts (sending always waits for your approval)",
  "contacts.lookup": "Look up people in your contacts",
  "calendar.read": "Read your calendar",
  "calendar.hold.prepare": "Prepare holds on your own calendar",
  "calendar.invite.prepare": "Prepare calendar invites (sending always waits for your approval)",
  "files.read": "Search and read your files",
  "video.create_room": "Create video meeting rooms",
  "grocery.search": "Search groceries",
  "grocery.cart.add": "Add groceries to your cart",
  "grocery.checkout": "Check out a grocery order",
  "device.call": "Start a phone call",
  "device.open_url": "Open a link on your phone",
};
