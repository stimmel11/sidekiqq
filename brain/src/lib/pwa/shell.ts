import { NextResponse, type NextRequest } from "next/server";
import { NONCE_HEADER, buildCsp, isDevEnv, makeNonce, shellResponseHeaders } from "./headers";

/**
 * Lets an app-shell page request through with a fresh CSP nonce (docs/WEBAPP.md §8).
 * The policy goes on the forwarded request (Next.js reads the nonce from it for its inline
 * scripts) and on the response, together with the other shell headers.
 */
export function nextWithShellHeaders(req: NextRequest, env: Record<string, string | undefined> = process.env): NextResponse {
  const nonce = makeNonce();
  const csp = buildCsp(nonce, { dev: isDevEnv(env) });
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [k, v] of Object.entries(shellResponseHeaders(csp))) res.headers.set(k, v);
  return res;
}
