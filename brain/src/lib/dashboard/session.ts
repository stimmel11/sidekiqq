/**
 * Owner dashboard session: a stateless, HMAC-SHA256 signed cookie.
 *
 * Format: `v1.<expiresAtEpochSeconds>.<nonce>.<signature>` (signature = base64url HMAC over the
 * first three parts, keyed by SESSION_SECRET). Uses Web Crypto only, so the same code runs in the
 * edge middleware and in Node server actions. Logout clears the cookie; rotating SESSION_SECRET
 * invalidates every outstanding session.
 */

export const SESSION_COOKIE = "skq_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MIN_SESSION_SECRET_LENGTH = 32;
const VERSION = "v1";

export class SessionNotConfiguredError extends Error {
  constructor() {
    super(`SESSION_SECRET must be set to at least ${MIN_SESSION_SECRET_LENGTH} characters`);
    this.name = "SessionNotConfiguredError";
  }
}

/** Returns the configured secret, or null when unset/too short (dashboard login is then disabled). */
export function sessionSecretFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.SESSION_SECRET?.trim();
  return s && s.length >= MIN_SESSION_SECRET_LENGTH ? s : null;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface SessionToken {
  value: string;
  expiresAt: Date;
}

export async function signSession(secret: string, now: Date = new Date(), ttlSeconds = SESSION_TTL_SECONDS): Promise<SessionToken> {
  if (secret.length < MIN_SESSION_SECRET_LENGTH) throw new SessionNotConfiguredError();
  const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `${VERSION}.${exp}.${nonce}`;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload)));
  return { value: `${payload}.${b64url(sig)}`, expiresAt: new Date(exp * 1000) };
}

/** True only for an untampered, unexpired token signed with `secret`. Never throws. */
export async function verifySession(value: string | null | undefined, secret: string | null, now: Date = new Date()): Promise<boolean> {
  if (!value || !secret || value.length > 256) return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const [version, expRaw, nonce, sigRaw] = parts as [string, string, string, string];
  if (version !== VERSION || !/^\d{1,12}$/.test(expRaw) || !nonce) return false;
  const exp = Number(expRaw);
  if (exp * 1000 <= now.getTime()) return false;
  // Reject tokens claiming a lifetime longer than we ever issue (defense against a leaked key misuse window).
  if (exp * 1000 > now.getTime() + (SESSION_TTL_SECONDS + 60) * 1000) return false;
  const sig = fromB64url(sigRaw);
  if (!sig || sig.length !== 32) return false;
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(`${version}.${expRaw}.${nonce}`));
  } catch {
    return false;
  }
}

/** Cookie attributes for the session (httpOnly, Secure, SameSite=Strict, whole site). */
export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "strict" as const,
    path: "/",
    expires: expiresAt,
  };
}
