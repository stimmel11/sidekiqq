import { google, type gmail_v1 } from "googleapis";
import type { OAuth2Client } from "./auth";
import { buildMime, toBase64Url } from "./mime";
import { truncate } from "../util";

/**
 * Read + draft access to the owner's Google Workspace.
 *
 * SAFETY: this interface deliberately has NO send capability. Sending lives in ./sender.ts and
 * is only wired into /api/drafts/[id]/approve (enforced by test/no-send.test.ts).
 */
export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
}

export interface EmailMessage extends EmailSummary {
  cc: string;
  messageIdHeader?: string;
  references?: string;
  body: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  attendees: string[];
  description?: string;
  htmlLink?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  owners: string[];
  content?: string;
}

export interface DraftInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  threadId?: string;
}

/** Raw header values of a provider draft, for the approve-time drift check. */
export interface DraftEnvelope {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
}

/** RFC 2047 encoded-words (`=?UTF-8?B?...?=` / `?Q?`) → text; plain values pass through. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?") // whitespace between adjacent encoded-words is not part of the text
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
      if (!/^utf-?8$/i.test(charset) && !/^(us-)?ascii$/i.test(charset) && !/^iso-8859-1$/i.test(charset)) return whole;
      const bytes =
        enc.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
      return bytes.toString(/^iso-8859-1$/i.test(charset) ? "latin1" : "utf8");
    });
}

export interface Workspace {
  searchGmail(query: string, maxResults: number): Promise<EmailSummary[]>;
  getThread(threadId: string): Promise<EmailMessage[]>;
  getMessage(messageId: string): Promise<EmailMessage>;
  listMessageIds(query: string, maxResults: number): Promise<{ id: string; threadId: string }[]>;
  listCalendarEvents(opts: { timeMin: string; timeMax: string; query?: string; maxResults: number }): Promise<CalendarEvent[]>;
  searchDrive(query: string, maxResults: number, includeContent: boolean): Promise<DriveFile[]>;
  createDraft(input: DraftInput): Promise<{ gmailDraftId: string; threadId?: string }>;
  /** The draft's To/Cc/Subject header values as Gmail holds them now, or null if it no longer exists. */
  getDraftEnvelope(gmailDraftId: string): Promise<DraftEnvelope | null>;
  ownerEmail(): Promise<string | undefined>;
}

const BODY_LIMIT = 8000;

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeB64(data: string | null | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/** Prefer text/plain; fall back to stripped text/html; walk multipart trees. */
export function extractBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: gmail_v1.Schema$MessagePart) => {
    if (p.filename) return; // attachment
    if (p.mimeType === "text/plain" && p.body?.data) plain.push(decodeB64(p.body.data));
    else if (p.mimeType === "text/html" && p.body?.data) html.push(decodeB64(p.body.data));
    p.parts?.forEach(walk);
  };
  walk(part);
  const text = plain.length ? plain.join("\n") : stripHtml(html.join("\n"));
  // Drop quoted reply history ("On ... wrote:") to keep the model focused on the new content.
  const cut = text.search(/\n(On .{5,200}wrote:|-{2,} ?Original Message ?-{2,})/);
  return truncate((cut > 0 ? text.slice(0, cut) : text).trim(), BODY_LIMIT);
}

function toSummary(msg: gmail_v1.Schema$Message): EmailSummary {
  const dateHeader = header(msg, "Date");
  const internal = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : undefined;
  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    from: header(msg, "From"),
    to: header(msg, "To"),
    subject: header(msg, "Subject"),
    date: internal ?? (dateHeader ? new Date(dateHeader).toISOString() : ""),
    snippet: msg.snippet ?? "",
    labels: msg.labelIds ?? [],
  };
}

function toMessage(msg: gmail_v1.Schema$Message): EmailMessage {
  const messageIdHeader = header(msg, "Message-ID") || header(msg, "Message-Id");
  const references = header(msg, "References");
  return {
    ...toSummary(msg),
    cc: header(msg, "Cc"),
    ...(messageIdHeader ? { messageIdHeader } : {}),
    ...(references ? { references } : {}),
    body: extractBody(msg.payload),
  };
}

const GOOGLE_DOC_EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export class GoogleWorkspace implements Workspace {
  private readonly gmail: gmail_v1.Gmail;
  private readonly calendar;
  private readonly drive;

  constructor(auth: OAuth2Client) {
    this.gmail = google.gmail({ version: "v1", auth });
    this.calendar = google.calendar({ version: "v3", auth });
    this.drive = google.drive({ version: "v3", auth });
  }

  async listMessageIds(query: string, maxResults: number) {
    const res = await this.gmail.users.messages.list({ userId: "me", q: query, maxResults });
    return (res.data.messages ?? []).filter((m) => m.id && m.threadId).map((m) => ({ id: m.id!, threadId: m.threadId! }));
  }

  async searchGmail(query: string, maxResults: number): Promise<EmailSummary[]> {
    const ids = await this.listMessageIds(query, maxResults);
    const msgs = await Promise.all(
      ids.map((m) =>
        this.gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        }),
      ),
    );
    return msgs.map((r) => toSummary(r.data));
  }

  async getMessage(messageId: string): Promise<EmailMessage> {
    const res = await this.gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    return toMessage(res.data);
  }

  async getThread(threadId: string): Promise<EmailMessage[]> {
    const res = await this.gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    return (res.data.messages ?? []).map(toMessage);
  }

  async listCalendarEvents(opts: { timeMin: string; timeMax: string; query?: string; maxResults: number }) {
    const res = await this.calendar.events.list({
      calendarId: "primary",
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: opts.maxResults,
      ...(opts.query ? { q: opts.query } : {}),
    });
    return (res.data.items ?? []).map((e) => ({
      id: e.id ?? "",
      summary: e.summary ?? "(no title)",
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
      ...(e.location ? { location: e.location } : {}),
      attendees: (e.attendees ?? []).map((a) => a.displayName ? `${a.displayName} <${a.email}>` : a.email ?? "").filter(Boolean),
      ...(e.description ? { description: truncate(e.description, 1000) } : {}),
      ...(e.htmlLink ? { htmlLink: e.htmlLink } : {}),
    }));
  }

  async searchDrive(query: string, maxResults: number, includeContent: boolean): Promise<DriveFile[]> {
    const escaped = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const res = await this.drive.files.list({
      q: `fullText contains '${escaped}' and trashed = false`,
      pageSize: maxResults,
      fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress))",
      orderBy: "modifiedTime desc",
    });
    const files = res.data.files ?? [];
    return Promise.all(
      files.map(async (f) => {
        const base: DriveFile = {
          id: f.id ?? "",
          name: f.name ?? "",
          mimeType: f.mimeType ?? "",
          ...(f.modifiedTime ? { modifiedTime: f.modifiedTime } : {}),
          ...(f.webViewLink ? { webViewLink: f.webViewLink } : {}),
          owners: (f.owners ?? []).map((o) => o.displayName ?? o.emailAddress ?? "").filter(Boolean),
        };
        const exportType = f.mimeType ? GOOGLE_DOC_EXPORTS[f.mimeType] : undefined;
        if (includeContent && f.id && exportType) {
          try {
            const ex = await this.drive.files.export({ fileId: f.id, mimeType: exportType }, { responseType: "text" });
            base.content = truncate(String(ex.data ?? ""), 4000);
          } catch {
            // Content is best-effort; metadata is still useful.
          }
        }
        return base;
      }),
    );
  }

  async createDraft(input: DraftInput) {
    let inReplyTo: string | undefined;
    let references: string | undefined;
    if (input.threadId) {
      const thread = await this.getThread(input.threadId);
      const last = thread[thread.length - 1];
      if (last?.messageIdHeader) {
        inReplyTo = last.messageIdHeader;
        references = [last.references, last.messageIdHeader].filter(Boolean).join(" ");
      }
    }
    const raw = toBase64Url(
      buildMime({
        to: input.to,
        ...(input.cc ? { cc: input.cc } : {}),
        subject: input.subject,
        body: input.body,
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references ? { references } : {}),
      }),
    );
    const res = await this.gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw, ...(input.threadId ? { threadId: input.threadId } : {}) } },
    });
    if (!res.data.id) throw new Error("Gmail did not return a draft id");
    const threadId = res.data.message?.threadId ?? undefined;
    return { gmailDraftId: res.data.id, ...(threadId ? { threadId } : {}) };
  }

  async getDraftEnvelope(gmailDraftId: string): Promise<DraftEnvelope | null> {
    try {
      const res = await this.gmail.users.drafts.get({ userId: "me", id: gmailDraftId, format: "metadata" });
      if (!res.data.id || !res.data.message) return null;
      const m = res.data.message;
      return { to: header(m, "To"), cc: header(m, "Cc"), bcc: header(m, "Bcc"), subject: decodeEncodedWords(header(m, "Subject")) };
    } catch (err) {
      if ((err as { code?: number }).code === 404) return null;
      throw err;
    }
  }

  async ownerEmail() {
    const res = await this.gmail.users.getProfile({ userId: "me" });
    return res.data.emailAddress ?? undefined;
  }
}
