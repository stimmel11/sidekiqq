/**
 * Security headers for the web app shell (docs/WEBAPP.md §8). Edge-safe: used from middleware.
 *
 * The CSP uses a per-request nonce. Next.js reads the nonce from the request's
 * `Content-Security-Policy` header and stamps it on its own inline hydration scripts, so the
 * middleware forwards the policy on the request as well as setting it on the response.
 */

export const NONCE_HEADER = "x-nonce";

/** Font hosts used by app/(dashboard)/layout.tsx. Nothing else third-party is allowed. */
const FONT_CSS_HOST = "https://fonts.googleapis.com";
const FONT_FILE_HOST = "https://fonts.gstatic.com";

export const PERMISSIONS_POLICY = "microphone=(self), camera=(), geolocation=()";

/** 128 random bits, base64. */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function buildCsp(nonce: string, opts: { dev?: boolean } = {}): string {
  if (!/^[A-Za-z0-9+/=]{16,}$/.test(nonce)) throw new Error("invalid CSP nonce");
  const dev = opts.dev === true;
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    // 'strict-dynamic': scripts loaded by a nonced script are trusted (Next.js chunk loading).
    // 'unsafe-eval' only in `next dev` (React Refresh); never in production.
    ["script-src", ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])]],
    // 'unsafe-inline' until React style={} attributes are audited out (WEBAPP.md §8).
    ["style-src", ["'self'", "'unsafe-inline'", FONT_CSS_HOST]],
    ["font-src", ["'self'", FONT_FILE_HOST]],
    ["img-src", ["'self'", "data:", "blob:"]],
    ["connect-src", ["'self'", ...(dev ? ["ws:"] : [])]],
    ["media-src", ["'self'", "blob:"]],
    ["worker-src", ["'self'"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives.map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

export function isDevEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "development";
}

/** Headers for an app-shell page response (dashboard and /login). The page carries personal data: never cached. */
export function shellResponseHeaders(csp: string): Record<string, string> {
  return {
    "Content-Security-Policy": csp,
    "Cache-Control": "private, no-store",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": PERMISSIONS_POLICY,
  };
}
