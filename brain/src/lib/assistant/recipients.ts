/**
 * Recipient provenance for /api/ask drafts ("never guess an address").
 *
 * Every address put on a draft must have come from somewhere the model actually saw in this
 * conversation: the owner's own words (typed, or dictated as "dana at acme dot com"), the
 * conversation history, or a tool result from this request (lookup_contact, an email thread,
 * a client profile, a follow-up...). An address the model made up ("dana@acme.com" because the
 * owner said "Dana from ACME") is rejected with a recoverable tool error that tells it to call
 * lookup_contact or ask the owner.
 *
 * This guards against invented addresses, not against prompt injection: an address that appears
 * in untrusted email content is "seen". The owner still hears every recipient in the read-back
 * and must say "send it" before POST /api/drafts/:id/approve sends anything.
 *
 * Only read tools count (PROVENANCE_TOOLS in ./tools.ts); write tools echo the model's input.
 * An ambiguous lookup_contact result makes every candidate "known"; choosing among them is
 * left to the prompt rule (ask the owner) and the read-back.
 */

// Deliberately loose (the strict check is isPlausibleEmail); we only need to find candidates.
// Bounded runs + a left boundary keep the scan linear-ish on long attacker-controlled strings.
const EMAIL_RE = /(?<![A-Za-z0-9._%+'-])[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;

// JSON escapes (tool results are JSON.stringify'd): "Thanks,\ndana@acme.com" must not read as
// "ndana@acme.com". Replace the two-character escapes with a space before scanning.
const JSON_ESCAPE_RE = /\\[nrtbf"\\/]/g;

// Spoken / mixed forms from speech-to-text: "dana at acme dot com", "dana.kim at acme dot com",
// "dana at acme.com", "dana dot kim at acme dot co dot uk", "j underscore lee at mail dash host dot io".
// A word may itself contain literal . _ - (STT often writes those). Spelled-out letters
// ("d a n a at ...") are not handled: the owner gets asked for the address instead.
const WORD = "[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?";
const SEP = "\\s+(?:dot|period|underscore|dash|hyphen)\\s+";
const LABEL = `${WORD}(?:\\s+(?:dash|hyphen)\\s+${WORD}){0,4}`;
const SPOKEN_RE = new RegExp(`(?<![A-Za-z0-9._-])(${WORD}(?:${SEP}${WORD}){0,3})\\s+at\\s+(${LABEL}(?:\\s+dot\\s+${LABEL}){0,4})(?![A-Za-z0-9])`, "gi");

const SEP_CHAR: Record<string, string> = { dot: ".", period: ".", underscore: "_", dash: "-", hyphen: "-" };

function joinSpoken(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => SEP_CHAR[w.toLowerCase()] ?? w)
    .join("");
}

/** True for exactly one address, bare or "Name <a@b.c>": no lists, no second "@". */
export function isSingleAddress(addr: string): boolean {
  return (addr.match(/@/g) ?? []).length === 1 && !/[,;]/.test(addr);
}

/** Normalise one address for comparison: bare, lower-case. Accepts "Name <a@b.c>". */
export function normalizeAddress(addr: string): string {
  const m = /<([^<>\s]+)>\s*$/.exec(addr.trim());
  return (m?.[1] ?? addr).trim().toLowerCase();
}

/** All addresses written in `text`, including spoken ones ("dana at acme dot com"). */
export function extractAddresses(text: string): string[] {
  const out = new Set<string>();
  const clean = text.replace(JSON_ESCAPE_RE, " ");
  for (const m of clean.matchAll(EMAIL_RE)) out.add(m[0].replace(/^['.]+|['.]+$/g, "").toLowerCase());
  for (const m of clean.matchAll(SPOKEN_RE)) {
    const domain = joinSpoken(m[2]!);
    if (!domain.includes(".")) continue; // "at noon" is English, not an address
    out.add(`${joinSpoken(m[1]!)}@${domain}`.toLowerCase());
  }
  return [...out];
}

export class KnownAddresses {
  private readonly seen = new Set<string>();

  /** Record every address in a piece of text the model has seen. */
  addText(text: string): void {
    for (const a of extractAddresses(text)) this.seen.add(a);
  }

  has(addr: string): boolean {
    // One address per item: "mallory@evil.example, Dana <dana@acme.com>" is never "known",
    // even though its bracketed part is.
    if (!isSingleAddress(addr)) return false;
    return this.seen.has(normalizeAddress(addr));
  }

  /** The addresses (as given) that never appeared anywhere the model could have read them. */
  unknown(addrs: readonly string[]): string[] {
    return addrs.filter((a) => !this.has(a));
  }
}
