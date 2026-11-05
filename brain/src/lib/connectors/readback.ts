import { addressesIn, FORMAT_CHARS } from "../address";

/**
 * The one-sentence read-back a device speaks (or shows) before asking the owner to confirm a
 * pending Draft (docs/CONNECTORS.md §5).
 *
 * BUILT IN CODE, NEVER BY THE MODEL. It is a fixed template over the structured fields: the kind,
 * every recipient or attendee address in full, the time for calendar kinds, and last the subject
 * or title. Nothing from the body is used.
 *
 * Recipients: new drafts store only strict bare addresses (lib/address.ts). For records written
 * before that, every address-looking token in an entry is read out, so a smuggled list
 * (`a@x.co, Dana <b@y.co>`) names both addresses rather than one.
 *
 * The subject is untrusted text: it is flattened to one line, stripped of format characters
 * (bidi, zero-width), email-like tokens become "[address]", quotes are neutralised, it is capped,
 * and it is framed as "with the subject: <subject>." at the very end, after every address.
 */

export type ReadbackKind = "email" | "calendar_invite" | "calendar_hold";

export interface ReadbackFields {
  kind?: ReadbackKind;
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  when?: { start: string; end: string };
}

/** Longest subject/title spoken. Addresses are never shortened. */
export const READBACK_SUBJECT_MAX = 120;

/**
 * Longest read-back accepted: Reachy speaks it through POST /api/speak, whose default limit
 * (SPEAK_MAX_CHARS) is 1000. Longer is refused at draft creation, never truncated.
 */
export const READBACK_MAX_CHARS = 1000;

export class ReadbackTooLongError extends Error {
  constructor(readonly length: number) {
    super(`The read-back would be ${length} characters (max ${READBACK_MAX_CHARS}). Use fewer or shorter recipients.`);
    this.name = "ReadbackTooLongError";
  }
}

/** Throws ReadbackTooLongError when `readback` can't be spoken in one /api/speak call. */
export function assertReadbackFits(readback: string): string {
  if (readback.length > READBACK_MAX_CHARS) throw new ReadbackTooLongError(readback.length);
  return readback;
}

/** Every address in one recipient entry (a strict address yields itself). */
export function entryAddresses(entry: string): string[] {
  return addressesIn(entry);
}

/** "a", "a and b", "a, b and c". */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// Built from code points so no line/paragraph separator or curly quote sits literally in the source.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u0085\\u2028\\u2029]+", "g");
const SINGLE_QUOTES = new RegExp("['`\\u2018\\u2019]", "g");
const DOUBLE_QUOTES = new RegExp("[\"\\u201c\\u201d]", "g");
const RIGHT_SINGLE = "’";
const RIGHT_DOUBLE = "”";
const EMAILISH = /[^\s<>,;:"()[\]]+@[^\s<>,;:"()[\]]+/g;

/** One line, no control or format characters, no addresses, quotes neutralised, capped. */
export function cleanSubject(s: string): string {
  const flat = s
    .replace(FORMAT_CHARS, "")
    .replace(CONTROL, " ")
    .replace(EMAILISH, "[address]")
    .replace(SINGLE_QUOTES, RIGHT_SINGLE)
    .replace(DOUBLE_QUOTES, RIGHT_DOUBLE)
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  return flat.length > READBACK_SUBJECT_MAX ? `${flat.slice(0, READBACK_SUBJECT_MAX - 1).trimEnd()}…` : flat;
}

/** "Tue Oct 27 2–3 pm" / "Tue Oct 27 11:30 am–1 pm" / across days: "Tue Oct 27 11 pm – Wed Oct 28 1 am". */
export function formatWhen(when: { start: string; end: string }, timeZone: string): string {
  const start = new Date(when.start);
  const end = new Date(when.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "at an unknown time";
  const parts = (d: Date) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
        .formatToParts(d)
        .map((x) => [x.type, x.value]),
    ) as Record<string, string>;
    const time = p.minute === "00" ? `${p.hour}` : `${p.hour}:${p.minute}`;
    return { day: `${p.weekday} ${p.month} ${p.day}`, time, ampm: (p.dayPeriod ?? "").toLowerCase() };
  };
  const a = parts(start);
  const b = parts(end);
  if (a.day !== b.day) return `${a.day} ${a.time} ${a.ampm} – ${b.day} ${b.time} ${b.ampm}`;
  if (a.ampm === b.ampm) return `${a.day} ${a.time}–${b.time} ${b.ampm}`;
  return `${a.day} ${a.time} ${a.ampm}–${b.time} ${b.ampm}`;
}

/**
 * Examples:
 *  - `Email to dana@acme.com, cc ops@acme.com, with the subject: Proposal follow-up.`
 *  - `Calendar invite to dana@acme.com and lee@acme.com, Tue Oct 27 2–3 pm, with the title: Kickoff.`
 *  - `Calendar hold, Tue Oct 27 9–11 am, with the title: Focus time.`
 * Pure: it never throws. Callers that create drafts also call assertReadbackFits.
 */
export function buildReadback(d: ReadbackFields, timeZone = "UTC"): string {
  const kind = d.kind ?? "email";
  const to = d.to.flatMap(entryAddresses);
  const cc = (d.cc ?? []).flatMap(entryAddresses);
  const subject = cleanSubject(d.subject);
  const when = d.when ? formatWhen(d.when, timeZone) : "at an unknown time";
  const titled = (word: string) => (subject ? `with the ${word}: ${subject}.` : `with no ${word}.`);
  switch (kind) {
    case "calendar_invite":
      return `Calendar invite to ${list(to) || "no one"}, ${when}, ${titled("title")}`;
    case "calendar_hold":
      return `Calendar hold, ${when}, ${titled("title")}`;
    default:
      return `Email to ${list(to) || "no recipient"}${cc.length ? `, cc ${list(cc)}` : ""}, ${titled("subject")}`;
  }
}
