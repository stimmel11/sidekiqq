/**
 * The one-sentence read-back a device speaks (or shows) before asking the owner to confirm a
 * pending Draft (docs/CONNECTORS.md §5).
 *
 * BUILT IN CODE, NEVER BY THE MODEL. It is a fixed template over the structured fields: the kind,
 * every recipient or attendee as a bare address in full (display names are dropped, since the model
 * writes them), the subject or title, and the time for calendar kinds. Nothing from the body is
 * used, so injected text in an email cannot change who the owner hears the message is going to.
 * The subject is untrusted text too: it is flattened to one line, its quotes are neutralised so it
 * can't close the quoted span, and it comes last, after every address.
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

/** `"Dana Lee" <dana@acme.com>` → `dana@acme.com`; a bare address is returned trimmed. */
export function bareAddress(addr: string): string {
  const m = /<([^<>\s]+)>\s*$/.exec(addr.trim());
  return (m?.[1] ?? addr.trim()).replace(CONTROL, "");
}

/** "a", "a and b", "a, b and c". */
function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** One line, no control characters, straight quotes replaced, capped. */
// Built from code points so no line/paragraph separator or curly quote sits literally in the source.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u0085\\u2028\\u2029]+", "g");
const SINGLE_QUOTES = new RegExp("['`\\u2018\\u2019]", "g");
const DOUBLE_QUOTES = new RegExp("[\"\\u201c\\u201d]", "g");
const RIGHT_SINGLE = "’";
const RIGHT_DOUBLE = "”";

export function cleanSubject(s: string): string {
  const flat = s
    .replace(CONTROL, " ")
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
 *  - `Email to dana@acme.com, cc ops@acme.com, subject 'Proposal follow-up'`
 *  - `Calendar invite to dana@acme.com and lee@acme.com, 'Kickoff', Tue Oct 27 2–3 pm`
 *  - `Calendar hold, 'Focus time', Tue Oct 27 9–11 am`
 */
export function buildReadback(d: ReadbackFields, timeZone = "UTC"): string {
  const kind = d.kind ?? "email";
  const to = d.to.map(bareAddress).filter(Boolean);
  const cc = (d.cc ?? []).map(bareAddress).filter(Boolean);
  const subject = cleanSubject(d.subject);
  const when = d.when ? formatWhen(d.when, timeZone) : "at an unknown time";
  switch (kind) {
    case "calendar_invite":
      return `Calendar invite to ${list(to) || "no one"}, ${subject ? `'${subject}'` : "no title"}, ${when}`;
    case "calendar_hold":
      return `Calendar hold, ${subject ? `'${subject}'` : "no title"}, ${when}`;
    default:
      return `Email to ${list(to) || "no recipient"}${cc.length ? `, cc ${list(cc)}` : ""}, ${subject ? `subject '${subject}'` : "no subject"}`;
  }
}
