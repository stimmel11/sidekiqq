/** Minimal RFC 5322 message builder for Gmail drafts (UTF-8, plain text). */

export interface MimeInput {
  from?: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

const HEADER_INJECTION = /[\r\n]/;

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word for any non-ASCII header value.
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function assertSafe(name: string, value: string) {
  if (HEADER_INJECTION.test(value)) throw new Error(`Header ${name} contains a line break`);
}

export function isPlausibleEmail(addr: string): boolean {
  // Accept "Name <a@b.c>" or "a@b.c"
  const m = /<([^<>\s]+)>\s*$/.exec(addr.trim());
  const email = m?.[1] ?? addr.trim();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email);
}

export function buildMime(m: MimeInput): string {
  const headers: [string, string][] = [];
  if (m.from) headers.push(["From", m.from]);
  headers.push(["To", m.to.join(", ")]);
  if (m.cc?.length) headers.push(["Cc", m.cc.join(", ")]);
  headers.push(["Subject", encodeHeader(m.subject)]);
  if (m.inReplyTo) headers.push(["In-Reply-To", m.inReplyTo]);
  if (m.references) headers.push(["References", m.references]);
  headers.push(["MIME-Version", "1.0"]);
  headers.push(["Content-Type", 'text/plain; charset="UTF-8"']);
  headers.push(["Content-Transfer-Encoding", "base64"]);
  for (const [k, v] of headers) assertSafe(k, v);

  const body = Buffer.from(m.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
  return `${headers.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${body}`;
}

export function toBase64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
