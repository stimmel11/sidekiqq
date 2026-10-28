import { google, type people_v1 } from "googleapis";
import type { OAuth2Client } from "./auth";
import { CONTACT_NAME_MAX_CHARS, CONTACT_NAME_RE, CONTACTS_DEFAULT_MAX, CONTACTS_MAX } from "./contacts-rules";

export { CONTACT_NAME_MAX_CHARS, CONTACTS_DEFAULT_MAX, CONTACTS_MAX } from "./contacts-rules";

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
 * - `name` and `org` are still third-party text (an Other contact's name is whatever a sender
 *   typed). Callers must treat them as untrusted data, never as instructions (CONNECTORS.md §4).
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

export interface ContactLookup {
  /** Best first. When `ambiguous`, at least the two top candidates are included even if `max` is 1. */
  contacts: Contact[];
  /**
   * True when the results don't single out one person, so the assistant must ask
   * ("Dana Kim or Dana Ortiz?") instead of picking.
   */
  ambiguous: boolean;
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

export class ContactsUnavailableError extends Error {
  constructor() {
    super("The People API isn't enabled in the Google Cloud project, so contacts can't be looked up.");
    this.name = "ContactsUnavailableError";
  }
}

export class ContactQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactQueryError";
  }
}

/** Returned names are capped tighter than queries: they are third-party text. */
const RESULT_NAME_MAX_CHARS = 60;
/** People API caps pageSize at 30 for both search endpoints. */
const PAGE_SIZE = 30;
/** Google refreshes its search cache asynchronously after an empty-query warm-up. */
const WARMUP_TTL_MS = 10 * 60_000;
const SAVED_MASK = "names,nicknames,emailAddresses,phoneNumbers,organizations";
// Other contacts only support emailAddresses, metadata, names and phoneNumbers.
const OTHER_MASK = "names,emailAddresses,phoneNumbers";
const RESULT_NAME_DISALLOWED = /[^\p{L}\p{M}\p{N} .'’&()-]+/gu;
const ID_RE = /^(people|otherContacts)\/c\d{1,25}$/;
const LOCAL_RE = /^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*$/;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Strip control, format (incl. bidi), private-use and lone-surrogate characters; collapse whitespace. */
export function cleanText(s: string | null | undefined, maxLen = 100): string {
  const t = (s ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Slice by code points so a surrogate pair is never split.
  return Array.from(t).slice(0, maxLen).join("").trim();
}

/** Validates and normalises the spoken name. Names are letters, spaces and . ' ’ - only. */
export function parseContactQuery(q: ContactQuery): { name: string; max: number } {
  const name = cleanText(q.name, 1000);
  if (!name) throw new ContactQueryError("Say a name to look up.");
  if (name.length > CONTACT_NAME_MAX_CHARS) throw new ContactQueryError(`Names are at most ${CONTACT_NAME_MAX_CHARS} characters.`);
  if (!CONTACT_NAME_RE.test(name)) throw new ContactQueryError("A contact name can only contain letters, spaces, and . ' -");
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

/**
 * ASCII addresses only: plain local part (no leading, trailing or double dots, no exotic atext) and
 * an ASCII domain. Punycode (`xn--`) domains can render as homographs, so they are dropped unless
 * `allowPunycode` (saved contacts the owner entered).
 */
export function cleanEmail(s: string | null | undefined, opts: { allowPunycode?: boolean } = {}): string | undefined {
  const e = (s ?? "").trim().toLowerCase();
  if (e.length > 254) return undefined;
  const at = e.lastIndexOf("@");
  if (at <= 0) return undefined;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local) || !DOMAIN_RE.test(domain)) return undefined;
  if (!opts.allowPunycode && domain.split(".").some((l) => l.startsWith("xn--"))) return undefined;
  return e;
}

/**
 * Validated, normalised dialable number: `+` and digits only (3–15 digits, the E.164 max).
 * Anything with `*`, `#`, `,` or `;` (MMI/USSD codes, post-dial digits) or letters is dropped.
 */
export function cleanPhone(p: people_v1.Schema$PhoneNumber): string | undefined {
  const raw = (p.canonicalForm || p.value || "").trim();
  if (!raw || /[*#,;]/.test(raw)) return undefined;
  if (!/^\+?[0-9\s().-]+$/.test(raw)) return undefined;
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length < 3 || digits.length > 15) return undefined;
  return (raw.startsWith("+") ? "+" : "") + digits;
}

function cleanResultName(s: string | null | undefined): string {
  return cleanText(cleanText(s, 200).replace(RESULT_NAME_DISALLOWED, " "), RESULT_NAME_MAX_CHARS);
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

/**
 * Rank used for ordering and ambiguity. An Other contact's name is set by whoever emailed the
 * owner, so it can never be "exact" enough to beat a saved contact that also matches by name.
 */
function effectiveRank(c: Contact): number {
  const r = MATCH_RANK[c.match];
  return c.source === "google_other" ? Math.max(r, MATCH_RANK.name) : r;
}

function toContact(person: people_v1.Schema$Person | undefined, source: ContactSource, query: string): Contact | undefined {
  const id = (person?.resourceName ?? "").trim();
  if (!person || !ID_RE.test(id)) return undefined;
  const allowPunycode = source === "google";
  const emails = [...new Set((person.emailAddresses ?? []).map((e) => cleanEmail(e.value, { allowPunycode })).filter((e): e is string => !!e))];
  const phones = [...new Set((person.phoneNumbers ?? []).map(cleanPhone).filter((p): p is string => !!p))];
  if (!emails.length && !phones.length) return undefined;
  const nameEntry = person.names?.find((n) => n.metadata?.primary) ?? person.names?.[0];
  const name =
    cleanResultName(nameEntry?.displayName ?? [nameEntry?.givenName, nameEntry?.familyName].filter(Boolean).join(" ")) ||
    emails[0] ||
    phones[0]!;
  const orgs = person.organizations ?? [];
  const org = cleanResultName((orgs.find((o) => o.metadata?.primary) ?? orgs[0])?.name);
  // Only the full display name can be "exact"; given/family/last-first names and nicknames are at best "name".
  const parts = [nameEntry?.givenName, nameEntry?.familyName, nameEntry?.displayNameLastFirst, ...(person.nicknames ?? []).map((n) => n.value)]
    .map((s) => cleanResultName(s))
    .filter(Boolean);
  const scores: Contact["match"][] = [
    scoreName(query, name),
    ...parts.map((c) => {
      const m = scoreName(query, c);
      return m === "exact" ? "name" : m;
    }),
  ];
  const match = scores.sort((a, b) => MATCH_RANK[a] - MATCH_RANK[b])[0] ?? "other";
  return { id, name, emails, phones, ...(org ? { org } : {}), source, match };
}

type ErrorKind = "access" | "disabled" | "other";

/** gaxios puts the HTTP status in `code`/`status` and Google's error body in `response.data.error`. */
function classifyError(err: unknown): ErrorKind {
  const e = err as {
    code?: number | string;
    status?: number;
    response?: { status?: number; data?: { error?: { status?: string; details?: { reason?: string }[] } } };
  };
  const status = Number(e?.response?.status ?? e?.status ?? e?.code);
  const body = e?.response?.data?.error;
  const reasons = (body?.details ?? []).map((d) => d?.reason);
  if (reasons.includes("SERVICE_DISABLED")) return "disabled";
  if (status === 401 || status === 403) return "access";
  return "other";
}

/** When the warm-up last ran. Single-owner brain, so one process-wide clock is enough. */
export interface WarmupState {
  at: number;
}
const processWarmup: WarmupState = { at: 0 };

/** Google `contacts.lookup`. */
export class GoogleContacts {
  constructor(
    private readonly api: PeopleApi,
    private readonly opts: { warmup?: WarmupState; now?: () => number } = {},
  ) {}

  /**
   * The People API wants an empty-query warm-up to refresh its search cache. The refresh is
   * asynchronous on Google's side, so it is fired (at most every 10 minutes) and never awaited.
   */
  private warmUp(): void {
    const state = this.opts.warmup ?? processWarmup;
    const now = (this.opts.now ?? Date.now)();
    if (now - state.at < WARMUP_TTL_MS) return;
    state.at = now;
    void Promise.allSettled([
      this.api.searchContacts({ query: "", readMask: SAVED_MASK, pageSize: 1 }),
      this.api.searchOtherContacts({ query: "", readMask: OTHER_MASK, pageSize: 1 }),
    ]);
  }

  async lookup(q: ContactQuery): Promise<ContactLookup> {
    const { name, max } = parseContactQuery(q);
    this.warmUp();
    const [saved, other] = await Promise.allSettled([
      this.api.searchContacts({ query: name, readMask: SAVED_MASK, pageSize: PAGE_SIZE }),
      this.api.searchOtherContacts({ query: name, readMask: OTHER_MASK, pageSize: PAGE_SIZE }),
    ]);
    if (saved.status === "rejected") {
      const kind = classifyError(saved.reason);
      if (kind === "access") throw new ContactsAccessError();
      if (kind === "disabled") throw new ContactsUnavailableError();
      throw saved.reason;
    }
    if (other.status === "rejected") {
      // Other contacts are best-effort only when the grant for them is missing.
      if (classifyError(other.reason) !== "access") throw other.reason;
      console.warn("[contacts] Other contacts search skipped: contacts.other.readonly not granted");
    }

    const savedContacts = (saved.value.data.results ?? [])
      .map((r) => toContact(r.person, "google", name))
      .filter((c): c is Contact => !!c);
    const savedEmails = new Set(savedContacts.flatMap((c) => c.emails));
    const otherContacts = (other.status === "fulfilled" ? other.value.data.results ?? [] : [])
      .map((r) => toContact(r.person, "google_other", name))
      .filter((c): c is Contact => !!c && !c.emails.some((e) => savedEmails.has(e)));

    const seen = new Set<string>();
    const ranked = [...savedContacts, ...otherContacts]
      .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
      .map((c, i) => ({ c, i }))
      .sort(
        (a, b) =>
          effectiveRank(a.c) - effectiveRank(b.c) ||
          (a.c.source === b.c.source ? 0 : a.c.source === "google" ? -1 : 1) ||
          MATCH_RANK[a.c.match] - MATCH_RANK[b.c.match] ||
          a.i - b.i,
      )
      .map(({ c }) => c);
    // Ambiguity is decided on the full list, before `max` trims it.
    const ambiguous = isAmbiguous(ranked);
    return { contacts: ranked.slice(0, ambiguous ? Math.max(max, 2) : max), ambiguous };
  }
}

/**
 * True when ranked results (best first) don't single out one person:
 * - the best is only a partial match ("Dana Smith" → "Dana Kim"), or
 * - the best is an Other contact and anyone else matched too, or
 * - the top two rank the same ("Dana" → "Dana Kim" and "Dana Ortiz").
 */
export function isAmbiguous(ranked: Contact[]): boolean {
  const [a, b] = ranked;
  if (!a) return false;
  if (MATCH_RANK[a.match] >= MATCH_RANK.partial) return true;
  if (!b) return false;
  if (a.source === "google_other") return true;
  return effectiveRank(a) === effectiveRank(b);
}
