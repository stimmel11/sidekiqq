import { google, type people_v1 } from "googleapis";
import type { OAuth2Client } from "./auth";

/**
 * `contacts.lookup` for Google (docs/CONNECTORS.md §2): resolve a spoken name to the owner's
 * contacts so "email this to Dana" never has to guess an address.
 *
 * - Read-only. Scopes: `contacts.readonly` (saved contacts) and `contacts.other.readonly`
 *   ("Other contacts": people the owner has emailed, auto-created by Gmail).
 * - Ambiguity is returned, never resolved: two "Dana"s → both, and the assistant asks.
 * - Saved contacts rank above Other contacts. Other contacts come from email display names that
 *   anyone can set, so they are labelled `source: "google_other"` and an Other contact that shares
 *   an address with a saved one is dropped (the saved one already covers it).
 * - Every string from Google is cleaned: control/format (bidi) characters stripped, emails and
 *   phone numbers validated. A contact with no usable email or phone is dropped.
 */

export type ContactSource = "google" | "google_other";

export interface Contact {
  /** Provider resource name (`people/c123`, `otherContacts/c456`). Stable id for `device.call`. */
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  org?: string;
  source: ContactSource;
  /** How well the name matched the query: exact > name (every word prefixes a name word) > partial > other. */
  match: "exact" | "name" | "partial" | "other";
}

export interface ContactQuery {
  name: string;
  max?: number;
}

/** The two People API calls we use. Injected so tests never touch the network. */
export interface PeopleApi {
  searchContacts(params: { query: string; readMask: string; pageSize: number }): Promise<{ data: people_v1.Schema$SearchResponse }>;
  searchOtherContacts(params: { query: string; readMask: string; pageSize: number }): Promise<{ data: people_v1.Schema$SearchResponse }>;
}

export function googlePeopleApi(auth: OAuth2Client): PeopleApi {
  const people = google.people({ version: "v1", auth });
  return {
    searchContacts: (p) => people.people.searchContacts(p),
    searchOtherContacts: (p) => people.otherContacts.search(p),
  };
}

export class ContactsAccessError extends Error {
  constructor() {
    super("Google Contacts access isn't granted. The owner must reconnect Google at /api/google/connect.");
    this.name = "ContactsAccessError";
  }
}

export class ContactQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactQueryError";
  }
}

export const CONTACTS_MAX = 10;
export const CONTACTS_DEFAULT_MAX = 5;
export const CONTACT_NAME_MAX_CHARS = 80;
/** People API caps pageSize at 30 for both search endpoints. */
const PAGE_SIZE = 30;
const SAVED_MASK = "names,emailAddresses,phoneNumbers,organizations";
const OTHER_MASK = "names,emailAddresses,phoneNumbers";
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** Strip control and format characters (incl. bidi overrides), collapse whitespace. */
export function cleanText(s: string | null | undefined, maxLen = 100): string {
  return (s ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen)
    .trim();
}

/** Validates and normalises the spoken name. Names are letters, spaces and . ' ’ - only. */
export function parseContactQuery(q: ContactQuery): { name: string; max: number } {
  const name = cleanText(q.name, 1000);
  if (!name) throw new ContactQueryError("Say a name to look up.");
  if (name.length > CONTACT_NAME_MAX_CHARS) throw new ContactQueryError(`Names are at most ${CONTACT_NAME_MAX_CHARS} characters.`);
  if (!NAME_RE.test(name)) throw new ContactQueryError("A contact name can only contain letters, spaces, and . ' -");
  const max = q.max ?? CONTACTS_DEFAULT_MAX;
  if (!Number.isInteger(max) || max < 1 || max > CONTACTS_MAX) throw new ContactQueryError(`max must be an integer from 1 to ${CONTACTS_MAX}.`);
  return { name, max };
}

/** Lower-case, strip diacritics and punctuation, so "Zoë O'Neil" matches "zoe oneil". */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function cleanEmail(s: string | null | undefined): string | undefined {
  const e = (s ?? "").trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : undefined;
}

/** Keep only dialable characters; 3–15 digits (E.164 max), no `*`, `#`, `,` or `;`. */
export function cleanPhone(p: people_v1.Schema$PhoneNumber): string | undefined {
  const raw = (p.canonicalForm || p.value || "").trim();
  if (!raw || /[*#,;]/.test(raw)) return undefined;
  if (!/^\+?[\d\s().-]+$/.test(raw)) return undefined;
  const digits = raw.replace(/\D/g, "").length;
  if (digits < 3 || digits > 15) return undefined;
  return raw.replace(/\s+/g, " ");
}

export function scoreName(query: string, candidate: string): Contact["match"] {
  const q = normalizeName(query);
  const c = normalizeName(candidate);
  if (!q || !c) return "other";
  if (q === c) return "exact";
  const qt = q.split(" ");
  const ct = c.split(" ");
  // Every query word prefixes a different name word, in any order ("dana" → "Dana Kim", "kim d" → "Dana Kim").
  const used = new Set<number>();
  const all = qt.every((w) => {
    const i = ct.findIndex((t, idx) => !used.has(idx) && t.startsWith(w));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
  if (all) return "name";
  if (qt.some((w) => ct.some((t) => t.startsWith(w)))) return "partial";
  return "other";
}

const MATCH_RANK: Record<Contact["match"], number> = { exact: 0, name: 1, partial: 2, other: 3 };

function toContact(person: people_v1.Schema$Person | undefined, source: ContactSource, query: string): Contact | undefined {
  if (!person?.resourceName) return undefined;
  const emails = [...new Set((person.emailAddresses ?? []).map((e) => cleanEmail(e.value)).filter((e): e is string => !!e))];
  const phones = [...new Set((person.phoneNumbers ?? []).map(cleanPhone).filter((p): p is string => !!p))];
  if (!emails.length && !phones.length) return undefined;
  const nameEntry = person.names?.find((n) => n.metadata?.primary) ?? person.names?.[0];
  const name = cleanText(nameEntry?.displayName ?? [nameEntry?.givenName, nameEntry?.familyName].filter(Boolean).join(" ")) || emails[0] || phones[0]!;
  const org = cleanText(person.organizations?.find((o) => o.metadata?.primary)?.name ?? person.organizations?.[0]?.name);
  // Only the full display name can be "exact"; given/family/last-first names can at best be "name".
  const parts = [nameEntry?.givenName, nameEntry?.familyName, nameEntry?.displayNameLastFirst].map((s) => cleanText(s)).filter(Boolean);
  const scores = [scoreName(query, name), ...parts.map((c) => (scoreName(query, c) === "exact" ? "name" : scoreName(query, c)))];
  const match = scores.sort((a, b) => MATCH_RANK[a] - MATCH_RANK[b])[0] ?? "other";
  return { id: cleanText(person.resourceName, 200), name, emails, phones, ...(org ? { org } : {}), source, match };
}

function isAccessError(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } };
  const status = Number(e?.code ?? e?.status ?? e?.response?.status);
  return status === 401 || status === 403;
}

/**
 * Google `contacts.lookup`. One instance per request; the People API's required empty-query
 * warm-up runs once per instance before the first search.
 */
export class GoogleContacts {
  private warmed: Promise<void> | undefined;

  constructor(private readonly api: PeopleApi) {}

  private warmUp(): Promise<void> {
    // Warm-up failures are ignored here; the real search reports access errors.
    this.warmed ??= Promise.allSettled([
      this.api.searchContacts({ query: "", readMask: SAVED_MASK, pageSize: 1 }),
      this.api.searchOtherContacts({ query: "", readMask: OTHER_MASK, pageSize: 1 }),
    ]).then(() => undefined);
    return this.warmed;
  }

  async lookup(q: ContactQuery): Promise<Contact[]> {
    const { name, max } = parseContactQuery(q);
    await this.warmUp();
    const [saved, other] = await Promise.allSettled([
      this.api.searchContacts({ query: name, readMask: SAVED_MASK, pageSize: PAGE_SIZE }),
      this.api.searchOtherContacts({ query: name, readMask: OTHER_MASK, pageSize: PAGE_SIZE }),
    ]);
    if (saved.status === "rejected") {
      if (isAccessError(saved.reason)) throw new ContactsAccessError();
      throw saved.reason;
    }
    // Other contacts are best-effort: a missing contacts.other.readonly grant still returns saved ones.
    if (other.status === "rejected" && !isAccessError(other.reason)) throw other.reason;

    const savedContacts = (saved.value.data.results ?? [])
      .map((r) => toContact(r.person, "google", name))
      .filter((c): c is Contact => !!c);
    const savedEmails = new Set(savedContacts.flatMap((c) => c.emails));
    const otherContacts = (other.status === "fulfilled" ? other.value.data.results ?? [] : [])
      .map((r) => toContact(r.person, "google_other", name))
      .filter((c): c is Contact => !!c && !c.emails.some((e) => savedEmails.has(e)));

    const seen = new Set<string>();
    return [...savedContacts, ...otherContacts]
      .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
      .map((c, i) => ({ c, i }))
      .sort((a, b) =>
        MATCH_RANK[a.c.match] - MATCH_RANK[b.c.match] ||
        (a.c.source === b.c.source ? 0 : a.c.source === "google" ? -1 : 1) ||
        a.i - b.i,
      )
      .slice(0, max)
      .map(({ c }) => c);
  }
}

/**
 * True when the top results don't single out one person, so the assistant must ask
 * ("Dana Kim or Dana Ortiz?") instead of picking.
 */
export function isAmbiguous(results: Contact[]): boolean {
  if (results.length <= 1) return false;
  const [a, b] = results;
  return MATCH_RANK[a!.match] === MATCH_RANK[b!.match];
}
