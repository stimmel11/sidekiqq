import { z } from "zod";
import { isPlausibleEmail } from "../google/mime";
import type { CalendarEvent, DriveFile, EmailMessage, EmailSummary } from "../google/workspace";

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

const address = z.string().trim().min(3).max(320).refine(isPlausibleEmail, "not a valid email address");

export const EmailDraftInput = z.object({
  to: z.array(address).min(1).max(10),
  cc: z.array(address).max(10).optional(),
  subject: z.string().trim().min(1).max(250),
  body: z.string().trim().min(1).max(20_000),
  threadId: id.optional(),
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

/** Provider draft created. `providerDraftId` is what the sender registry later sends. */
export interface EmailDraftOutput {
  providerDraftId: string;
  threadId?: string;
}

/** Input/output types per implemented capability. Unimplemented ones map to `never` until built. */
export interface CapabilityIO {
  "email.read": { in: EmailReadIn; out: EmailReadOutput<EmailReadIn> };
  "email.draft": { in: z.infer<typeof EmailDraftInput>; out: EmailDraftOutput };
  "calendar.read": { in: z.infer<typeof CalendarReadInput>; out: CalendarEvent[] };
  "files.read": { in: z.infer<typeof FilesReadInput>; out: DriveFile[] };
}
export type ImplementedCapability = keyof CapabilityIO;
export type In<C extends ImplementedCapability> = CapabilityIO[C]["in"];
export type Out<C extends ImplementedCapability> = CapabilityIO[C]["out"];

export const INPUT_SCHEMAS: { [C in ImplementedCapability]: z.ZodType<In<C>> } = {
  "email.read": EmailReadInput,
  "email.draft": EmailDraftInput,
  "calendar.read": CalendarReadInput,
  "files.read": FilesReadInput,
};

/** Plain words for the owner (Connections screen). */
export const TIER_LABEL: Record<Tier, string> = {
  auto: "reads automatically",
  confirm: "asks you first",
  user_finishes: "you finish on your phone",
};
