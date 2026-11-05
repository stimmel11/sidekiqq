/**
 * Strict email addresses for anything SideKiqq drafts (docs/CONNECTORS.md §5).
 *
 * Every recipient that reaches a provider draft, the stored Draft record and the spoken read-back
 * is ONE bare ASCII addr-spec, `local@domain`, produced here. No display names, no groups, no
 * comments, no lists: a string such as `mallory@evil.example, Dana <dana@acme.com>` is rejected
 * instead of being split by the MIME layer into two recipients while the read-back names one.
 * Internationalised domains are accepted only as `xn--` punycode, so look-alike Unicode
 * (Cyrillic "а", bidi overrides, zero-width characters) can't reach a draft.
 */

/** RFC 5321 path limit. */
export const ADDRESS_MAX = 254;

// RFC 5322 dot-atom text minus nothing risky: ",;:\"()<>[]@\\" and whitespace are never allowed.
const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * `dana@acme.com` or `<dana@acme.com>` → `dana@acme.com` (lower-cased). Anything else → null.
 */
export function normalizeAddress(raw: string): string | null {
  let s = raw.trim();
  const bracketed = /^<([^<>]*)>$/.exec(s);
  if (bracketed) s = bracketed[1]!.trim();
  if (!/^[\x21-\x7e]+$/.test(s)) return null; // printable ASCII only, no whitespace
  s = s.toLowerCase();
  if (s.length > ADDRESS_MAX) return null;
  const at = s.indexOf("@");
  if (at <= 0 || at !== s.lastIndexOf("@")) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return null; // no IP-ish TLDs
  return s;
}

export function isStrictAddress(raw: string): boolean {
  return normalizeAddress(raw) !== null;
}

/** Unicode format characters: bidi controls, zero-width characters, BOM, soft hyphen. */
export const FORMAT_CHARS = /\p{Cf}/gu;

/**
 * Every address-looking token in a header value or a legacy recipient entry, lower-cased, in order.
 * Used where the input is NOT already strict (provider headers, records stored before slice 3):
 * `mallory@evil.example, Dana <dana@acme.com>` → both addresses, `"a@x.co" <b@y.co>` → both.
 * Over-reporting is the safe direction: the read-back names more, a drift check refuses more.
 */
export function addressesIn(value: string): string[] {
  const s = value.replace(FORMAT_CHARS, "");
  return [...s.matchAll(/[^\s<>,;:"()[\]]+@[^\s<>,;:"()[\]]+/g)].map((m) => m[0].toLowerCase());
}
