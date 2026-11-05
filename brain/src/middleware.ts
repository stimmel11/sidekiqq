import { NextResponse, type NextRequest } from "next/server";
import { dashboardGuard, isDashboardPath } from "./lib/dashboard/guard";
import { SESSION_COOKIE } from "./lib/dashboard/session";

/**
 * Edge pre-filter: reject API calls without any bearer/secret header before they reach a
 * function. Real token verification happens in the route (lib/auth.ts) against Redis.
 */
const PUBLIC = ["/api/devices/pair", "/api/google/callback", "/api/google/connect", "/api/health"];
/** Browser legs of the generic connect flow: a single-use ticket (connect) or OAuth state (callback) is the check. */
const PUBLIC_CONNECTIONS = /^\/api\/connections\/[a-z][a-z0-9-]{0,39}\/(connect|callback)$/;
/** Owner connection routes also accept the dashboard session cookie (checked in the route, lib/auth.ts). */
const isConnectionsApi = (p: string) => p === "/api/connections" || p.startsWith("/api/connections/");

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isDashboardPath(pathname)) return dashboardGuard(req); // owner web dashboard: signed session cookie
  if (PUBLIC.includes(pathname)) return NextResponse.next();
  if (PUBLIC_CONNECTIONS.test(pathname)) return NextResponse.next();
  if (isConnectionsApi(pathname) && req.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const hasAuth = /^Bearer\s+\S+/i.test(req.headers.get("authorization") ?? "") || req.headers.has("x-owner-secret") || req.headers.has("x-cron-secret");
  if (!hasAuth) return NextResponse.json({ error: "Missing bearer token", code: "unauthorized" }, { status: 401 });
  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*", "/dashboard/:path*"] };
