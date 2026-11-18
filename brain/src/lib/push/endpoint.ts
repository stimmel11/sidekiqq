/**
 * Web Push endpoint allowlist (docs/WEBAPP.md §5). The brain POSTs every alert to the endpoint a
 * browser registered, so an unchecked endpoint would let a caller aim the brain at any URL (SSRF).
 * Only `https` URLs on the browsers' own push services pass, with no credentials and no port.
 *
 * Dependency-free on purpose: `lib/models.ts` uses it inside the register schema, and the sender
 * checks it again right before each POST.
 */

/** Exact hosts. */
const EXACT_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com"]);
/** Suffixes: one or more labels before them (e.g. `web.push.apple.com`, `wns2-by3p.notify.windows.com`). */
const HOST_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

export const MAX_PUSH_ENDPOINT_LENGTH = 2048;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type PushEndpointProblem = "too_long" | "not_a_url" | "not_https" | "credentials" | "port" | "host";

/** null when the endpoint may be used; otherwise why not. */
export function pushEndpointProblem(endpoint: string): PushEndpointProblem | null {
  if (endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) return "too_long";
  // Reject whitespace and control characters outright: URL() would silently strip some of them.
  if (/[\s\u0000-\u001f\u007f\\]/.test(endpoint)) return "not_a_url";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "not_a_url";
  }
  if (url.protocol !== "https:") return "not_https";
  if (url.username || url.password || /^https:\/\/[^/?#]*@/i.test(endpoint)) return "credentials";
  if (url.port !== "" || /^https:\/\/[^/?#]*:[^/?#]*(?:[/?#]|$)/i.test(endpoint)) return "port";
  const host = url.hostname; // already lower-cased; IDN becomes punycode
  if (!hostAllowed(host)) return "host";
  return null;
}

export function isAllowedPushEndpoint(endpoint: string): boolean {
  return pushEndpointProblem(endpoint) === null;
}

function hostAllowed(host: string): boolean {
  if (EXACT_HOSTS.has(host)) return true;
  for (const suffix of HOST_SUFFIXES) {
    if (!host.endsWith(suffix)) continue;
    const head = host.slice(0, -suffix.length);
    if (!head) return false;
    return head.split(".").every((l) => LABEL.test(l));
  }
  return false;
}

/** Base64url without padding, decoding to exactly `bytes` bytes. */
function isB64url(s: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
  if (s.length !== Math.ceil((bytes * 4) / 3)) return false;
  return Buffer.from(s, "base64url").length === bytes;
}

/** `keys.p256dh`: an uncompressed P-256 point (65 bytes, leading 0x04), base64url. */
export function isValidP256dh(s: string): boolean {
  if (!isB64url(s.replace(/=+$/, ""), 65)) return false;
  return Buffer.from(s, "base64url")[0] === 0x04;
}

/** `keys.auth`: the 16-byte auth secret, base64url. */
export function isValidPushAuth(s: string): boolean {
  return isB64url(s.replace(/=+$/, ""), 16);
}
