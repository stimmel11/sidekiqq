import { cleanEmail, cleanText } from "../google/contacts";
import type { EmailMessage, EmailSummary } from "../google/workspace";
import { truncate } from "../util";

/**
 * `email.read` for Outlook / Microsoft 365 via Microsoft Graph (docs/CONNECTORS.md §2, §10 step 7).
 * Slice 1: the provider module only. Connector registration, OAuth and the ConnectionStore come in
 * slice 2, so nothing here is wired into a route yet.
 *
 * SAFETY:
 * - Read-only. Every request is a `GET` to `https://graph.microsoft.com/v1.0/me...`. There is no
 *   draft, move, delete, flag or mark-as-read call, and no path that can send (Graph's send and
 *   reply endpoints send at once, CONNECTORS.md §6). test/outlook-mail.test.ts checks every request.
 * - Output uses the same `EmailSummary` / `EmailMessage` shapes as Gmail, so tools and prompts don't
 *   change per provider. Every string from Graph is third-party text: control and bidi characters
 *   are stripped, and callers must treat it as data, never as instructions (CONNECTORS.md §4.4).
 * - Pagination links are followed only when they stay on the same Graph origin and version.
 *
 * Query syntax for `search` is Graph's KQL (`from:dana subject:proposal`). Double quotes and
 * backslashes are removed because the query is sent inside `$search="..."`.
 */

export const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`;
export const OUTLOOK_TIMEOUT_MS = 15_000;
/** Largest Graph response body we read (bytes). A thread page of 50 text bodies fits easily. */
export const OUTLOOK_MAX_RESPONSE_BYTES = 4_000_000;
const BODY_LIMIT = 8000;
const SNIPPET_LIMIT = 300;
export const OUTLOOK_SEARCH_MAX = 25;
export const OUTLOOK_LIST_MAX = 500;
export const OUTLOOK_THREAD_MAX = 50;
const QUERY_MAX = 500;

/** Graph message ids and conversation ids: base64-like, URL-safe or not. */
const GRAPH_ID_RE = /^[A-Za-z0-9+/=_-]{1,512}$/;

/** Minimal fetch type, injected so tests never touch the network. */
export type FetchLike = (url: string, init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal; redirect: "error" }) => Promise<Response>;

/** Supplies a Microsoft access token. `invalidate` drops a cached token after a 401. */
export interface OutlookTokenSource {
  accessToken(): Promise<string>;
  invalidate?(): void;
}

export class OutlookAuthError extends Error {
  constructor() {
    super("Microsoft refused the stored sign-in. The owner needs to reconnect Outlook.");
    this.name = "OutlookAuthError";
  }
}

export class OutlookAccessError extends Error {
  constructor() {
    super("Outlook mail access isn't granted (Mail.Read is missing). The owner needs to reconnect Outlook.");
    this.name = "OutlookAccessError";
  }
}

export class OutlookNotFoundError extends Error {
  constructor(what: string) {
    super(`That ${what} wasn't found in Outlook.`);
    this.name = "OutlookNotFoundError";
  }
}

export class OutlookRateLimitError extends Error {
  constructor(readonly retryAfterSec?: number) {
    super("Outlook is busy right now. Try again in a minute.");
    this.name = "OutlookRateLimitError";
  }
}

export class OutlookInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutlookInputError";
  }
}

export class OutlookUnavailableError extends Error {
  constructor(detail: string) {
    super(`Outlook didn't answer (${detail}).`);
    this.name = "OutlookUnavailableError";
  }
}

// ---------------------------------------------------------------------------------------
// Graph shapes (only the fields we select)
// ---------------------------------------------------------------------------------------

interface GraphEmailAddress {
  emailAddress?: { name?: string | null; address?: string | null } | null;
}

export interface GraphMessage {
  id?: string;
  conversationId?: string;
  subject?: string | null;
  from?: GraphEmailAddress | null;
  toRecipients?: GraphEmailAddress[] | null;
  ccRecipients?: GraphEmailAddress[] | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  bodyPreview?: string | null;
  isRead?: boolean | null;
  isDraft?: boolean | null;
  importance?: "low" | "normal" | "high" | null;
  flag?: { flagStatus?: string | null } | null;
  internetMessageId?: string | null;
  internetMessageHeaders?: { name?: string | null; value?: string | null }[] | null;
  body?: { contentType?: string | null; content?: string | null } | null;
}

interface GraphPage<T> {
  value?: T[];
  "@odata.nextLink"?: string;
}

const SUMMARY_FIELDS = ["id", "conversationId", "subject", "from", "toRecipients", "receivedDateTime", "bodyPreview", "isRead", "isDraft", "importance", "flag"];
const MESSAGE_FIELDS = [...SUMMARY_FIELDS, "ccRecipients", "internetMessageId", "internetMessageHeaders", "body"];

// ---------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------

/** Clean a KQL query for `$search="..."`. Throws on empty or over-long input. */
export function cleanSearchQuery(q: string): string {
  const t = cleanText(q.replace(/["\\]/g, " "), QUERY_MAX + 1);
  if (!t) throw new OutlookInputError("Say what to search for.");
  if (t.length > QUERY_MAX) throw new OutlookInputError(`Searches are at most ${QUERY_MAX} characters.`);
  return t;
}

export function assertGraphId(id: string, what: string): string {
  const t = id.trim();
  if (!GRAPH_ID_RE.test(t)) throw new OutlookInputError(`That isn't a valid Outlook ${what} id.`);
  return t;
}

function assertMax(max: number, limit: number): number {
  if (!Number.isInteger(max) || max < 1 || max > limit) throw new OutlookInputError(`max must be an integer from 1 to ${limit}.`);
  return max;
}

/** `Name <addr>` like a Gmail header, or just the address. Unusable addresses are dropped. */
export function formatAddress(a: GraphEmailAddress | null | undefined): string {
  const addr = cleanEmail(a?.emailAddress?.address, { allowPunycode: true });
  if (!addr) return "";
  const name = cleanText(a?.emailAddress?.name, 100).replace(/[<>"]/g, "").trim();
  return name && name.toLowerCase() !== addr ? `${name} <${addr}>` : addr;
}

function formatList(list: GraphEmailAddress[] | null | undefined): string {
  return (list ?? []).slice(0, 50).map(formatAddress).filter(Boolean).join(", ");
}

/** Gmail-like labels so prompts read Outlook state the same way. */
export function labelsFor(m: GraphMessage): string[] {
  const labels: string[] = [];
  if (m.isRead === false) labels.push("UNREAD");
  if (m.importance === "high") labels.push("IMPORTANT");
  if (m.flag?.flagStatus === "flagged") labels.push("STARRED");
  if (m.isDraft) labels.push("DRAFT");
  return labels;
}

function isoOrEmpty(s: string | null | undefined): string {
  if (!s) return "";
  const t = Date.parse(s);
  return Number.isNaN(t) ? "" : new Date(t).toISOString();
}

/** Plain-text body: drops quoted history (Gmail- and Outlook-style separators) and caps the length. */
export function cleanBody(m: GraphMessage): string {
  let text = m.body?.content ?? "";
  if (m.body?.contentType && m.body.contentType.toLowerCase() !== "text") text = stripHtml(text); // Prefer header ignored
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, (c) => (c === "\n" || c === "\t" ? c : " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n");
  const cut = text.search(/\n(On .{5,200}wrote:|-{2,} ?Original Message ?-{2,}|_{10,}\s*\nFrom: |From: .{1,300}\nSent: )/);
  return truncate((cut > 0 ? text.slice(0, cut) : text).trim(), BODY_LIMIT);
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function header(m: GraphMessage, name: string): string {
  const h = (m.internetMessageHeaders ?? []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return cleanText(h?.value, 4000);
}

export function toSummary(m: GraphMessage): EmailSummary {
  return {
    id: m.id ?? "",
    threadId: m.conversationId ?? "",
    from: formatAddress(m.from),
    to: formatList(m.toRecipients),
    subject: cleanText(m.subject, 300),
    date: isoOrEmpty(m.receivedDateTime) || isoOrEmpty(m.sentDateTime),
    snippet: cleanText(m.bodyPreview, SNIPPET_LIMIT),
    labels: labelsFor(m),
  };
}

export function toMessage(m: GraphMessage): EmailMessage {
  const messageIdHeader = cleanText(m.internetMessageId, 1000);
  const references = header(m, "References");
  return {
    ...toSummary(m),
    cc: formatList(m.ccRecipients),
    ...(messageIdHeader ? { messageIdHeader } : {}),
    ...(references ? { references } : {}),
    body: cleanBody(m),
  };
}

function usable(m: GraphMessage): boolean {
  return typeof m.id === "string" && GRAPH_ID_RE.test(m.id) && typeof m.conversationId === "string" && GRAPH_ID_RE.test(m.conversationId);
}

// ---------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------

export interface OutlookMailOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class OutlookMail {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    private readonly tokens: OutlookTokenSource,
    opts: OutlookMailOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? OUTLOOK_TIMEOUT_MS;
  }

  /** KQL search across all folders. Graph returns relevance order and can't sort `$search` results. */
  async search(query: string, max: number): Promise<EmailSummary[]> {
    const q = cleanSearchQuery(query);
    assertMax(max, OUTLOOK_SEARCH_MAX);
    const url = buildUrl("/me/messages", { $search: `"${q}"`, $top: String(max), $select: SUMMARY_FIELDS.join(",") });
    const page = await this.get<GraphPage<GraphMessage>>(url);
    return (page.value ?? []).filter(usable).slice(0, max).map(toSummary);
  }

  /**
   * Ids of messages received in the Inbox and Sent Items since `since`, newest first, for the cron
   * scanner (the Gmail scanner's `(in:inbox OR in:sent) after:` query). Follows `@odata.nextLink`
   * up to `max` per folder, then merges and caps at `max`.
   */
  async listRecentIds(since: Date, max: number): Promise<{ id: string; threadId: string }[]> {
    assertMax(max, OUTLOOK_LIST_MAX);
    if (Number.isNaN(since.getTime())) throw new OutlookInputError("since must be a valid date.");
    const iso = since.toISOString();
    const perFolder = await Promise.all(
      [
        ["inbox", "receivedDateTime"],
        ["sentitems", "sentDateTime"],
      ].map(async ([folder, field]) => {
        const first = buildUrl(`/me/mailFolders/${folder}/messages`, {
          $filter: `${field} ge ${iso}`,
          $orderby: `${field} desc`,
          $top: String(Math.min(max, 100)),
          $select: `id,conversationId,${field}`,
        });
        const rows: { id: string; threadId: string; at: number }[] = [];
        for await (const m of this.pages<GraphMessage>(first, max)) {
          if (!usable(m)) continue;
          rows.push({ id: m.id!, threadId: m.conversationId!, at: Date.parse((field === "sentDateTime" ? m.sentDateTime : m.receivedDateTime) ?? "") || 0 });
        }
        return rows;
      }),
    );
    const seen = new Set<string>();
    return perFolder
      .flat()
      .sort((a, b) => b.at - a.at)
      .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
      .slice(0, max)
      .map(({ id, threadId }) => ({ id, threadId }));
  }

  async getMessage(id: string): Promise<EmailMessage> {
    const mid = assertGraphId(id, "message");
    const m = await this.get<GraphMessage>(buildUrl(`/me/messages/${encodeURIComponent(mid)}`, { $select: MESSAGE_FIELDS.join(",") }), "message");
    if (!usable(m)) throw new OutlookNotFoundError("message");
    return toMessage(m);
  }

  /** Every message in the conversation, oldest first (like a Gmail thread), up to 50. */
  async getThread(conversationId: string): Promise<EmailMessage[]> {
    const cid = assertGraphId(conversationId, "conversation");
    const url = buildUrl("/me/messages", {
      $filter: `conversationId eq '${cid.replace(/'/g, "''")}'`,
      $top: String(OUTLOOK_THREAD_MAX),
      $select: MESSAGE_FIELDS.join(","),
    });
    const msgs: GraphMessage[] = [];
    for await (const m of this.pages<GraphMessage>(url, OUTLOOK_THREAD_MAX)) if (usable(m) && m.conversationId === cid) msgs.push(m);
    if (!msgs.length) throw new OutlookNotFoundError("conversation");
    const at = (m: GraphMessage) => Date.parse(m.receivedDateTime ?? m.sentDateTime ?? "") || 0;
    return msgs.sort((a, b) => at(a) - at(b)).map(toMessage);
  }

  /** The connected mailbox's own address. */
  async account(): Promise<{ email?: string }> {
    const me = await this.get<{ mail?: string | null; userPrincipalName?: string | null }>(buildUrl("/me", { $select: "mail,userPrincipalName" }));
    const email = cleanEmail(me.mail, { allowPunycode: true }) ?? cleanEmail(me.userPrincipalName, { allowPunycode: true });
    return email ? { email } : {};
  }

  /** Yields items across pages, following nextLink only on the same Graph origin + version. */
  private async *pages<T>(first: string, max: number): AsyncGenerator<T> {
    let url: string | undefined = first;
    let n = 0;
    for (let page = 0; url && page < 20; page++) {
      const res: GraphPage<T> = await this.get<GraphPage<T>>(url);
      for (const item of res.value ?? []) {
        if (n++ >= max) return;
        yield item;
      }
      const next = res["@odata.nextLink"];
      url = typeof next === "string" && isGraphUrl(next) ? next : undefined;
    }
  }

  private async get<T>(url: string, what = "item", retried = false): Promise<T> {
    if (!isGraphUrl(url)) throw new OutlookUnavailableError("unexpected address");
    const token = await this.tokens.accessToken();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          Prefer: 'outlook.body-content-type="text"',
        },
        signal: ctl.signal,
        redirect: "error",
      });
      text = await readCapped(res, OUTLOOK_MAX_RESPONSE_BYTES);
    } catch (err) {
      if (err instanceof OutlookUnavailableError) throw err;
      throw new OutlookUnavailableError(ctl.signal.aborted ? "timed out" : "network error");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) {
      if (!retried && this.tokens.invalidate) {
        this.tokens.invalidate();
        return this.get<T>(url, what, true);
      }
      throw new OutlookAuthError();
    }
    if (res.status === 403) throw new OutlookAccessError();
    if (res.status === 404) throw new OutlookNotFoundError(what);
    if (res.status === 429 || res.status === 503) {
      const ra = Number(res.headers.get("retry-after"));
      throw new OutlookRateLimitError(Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    if (res.status === 400) throw new OutlookInputError("Outlook refused that request. For a search, try simpler words.");
    if (!res.ok) throw new OutlookUnavailableError(`HTTP ${res.status}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OutlookUnavailableError("unreadable reply");
    }
  }
}

export function isGraphUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === GRAPH_ORIGIN && (u.pathname === "/v1.0/me" || u.pathname.startsWith("/v1.0/me/")) && !u.username && !u.password;
  } catch {
    return false;
  }
}

function buildUrl(path: string, params: Record<string, string>): string {
  const u = new URL(GRAPH_BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new OutlookUnavailableError("reply too large");
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new OutlookUnavailableError("reply too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Scopes this module needs (CONNECTORS.md §7 lists `Mail.ReadWrite` once drafts land in slice 2). */
export const OUTLOOK_READ_SCOPES = ["offline_access", "User.Read", "Mail.Read"] as const;
