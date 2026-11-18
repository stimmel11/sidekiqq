import { NextResponse, type NextRequest } from "next/server";
import { LOGIN_PATH, dashboardGuard, isDashboardPath } from "./lib/dashboard/guard";
import { SESSION_COOKIE } from "./lib/dashboard/session";
import { nextWithShellHeaders } from "./lib/pwa/shell";

/**
 * Edge pre-filter: reject API calls without any bearer/secret header before they reach a
 * function. Real token verification happens in the route (lib/auth.ts) against Redis.
 */
const PUBLIC = ["/api/devices/pair", "/api/google/callback", "/api/google/connect", "/api/health"];
/** Browser legs of the generic connect flow: a single-use ticket (connect) or OAuth state (callback) is the check. */
const PUBLIC_CONNECTIONS = /^\/api\/connections\/[a-z][a-z0-9-]{0,39}\/(connect|callback)$/;
/** Owner connection routes also accept the dashboard session cookie (checked in the route, lib/auth.ts). */
const isConnectionsApi = (p: string) => p === "/api/connections" || p.startsWith("/api/connections/");
/**
 * Device routes on `withPrincipal` (lib/auth.ts): a device token or the dashboard session cookie,
 * verified in the route (plus the fail-closed same-origin check and, on approve, the confirmation
 * fingerprint). Add a route here only once it uses withPrincipal (docs/WEBAPP.md §4.2).
 */
const PRINCIPAL_ROUTES = [
  /^\/api\/drafts(\/[A-Za-z0-9_-]{1,64}\/(approve|discard))?$/,
  /^\/api\/(ask|transcribe|speak)$/,
  /^\/api\/commitments(\/[A-Za-z0-9_-]{1,64}\/complete)?$/,
];
const isPrincipalRoute = (p: string) => PRINCIPAL_ROUTES.some((r) => r.test(p));

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isDashboardPath(pathname)) return dashboardGuard(req); // owner web dashboard: signed session cookie
  if (pathname === LOGIN_PATH) return nextWithShellHeaders(req); // sign-in page: CSP nonce + shell headers, no session needed
  if (PUBLIC.includes(pathname)) return apiNext();
  if (PUBLIC_CONNECTIONS.test(pathname)) return apiNext();
  if (isConnectionsApi(pathname) && req.cookies.has(SESSION_COOKIE)) return apiNext();
  if (isPrincipalRoute(pathname) && req.cookies.has(SESSION_COOKIE)) return apiNext();
  const hasAuth = /^Bearer\s+\S+/i.test(req.headers.get("authorization") ?? "") || req.headers.has("x-owner-secret") || req.headers.has("x-cron-secret");
  if (!hasAuth) return NextResponse.json({ error: "Missing bearer token", code: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return apiNext();
}

/**
 * API replies carry personal data: keep them out of the browser's HTTP cache (WEBAPP.md §1.1).
 * A future route that should be cacheable must be exempted here, not just set its own header.
 */
function apiNext(): NextResponse {
  const res = NextResponse.next();
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export const config = { matcher: ["/api/:path*", "/dashboard/:path*", "/login"] };
