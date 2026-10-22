import { NextResponse, type NextRequest } from "next/server";
import { dashboardGuard, isDashboardPath } from "./lib/dashboard/guard";

/**
 * Edge pre-filter: reject API calls without any bearer/secret header before they reach a
 * function. Real token verification happens in the route (lib/auth.ts) against Redis.
 */
const PUBLIC = ["/api/devices/pair", "/api/google/callback", "/api/google/connect", "/api/health"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isDashboardPath(pathname)) return dashboardGuard(req); // owner web dashboard: signed session cookie
  if (PUBLIC.includes(pathname)) return NextResponse.next();
  const hasAuth = /^Bearer\s+\S+/i.test(req.headers.get("authorization") ?? "") || req.headers.has("x-owner-secret") || req.headers.has("x-cron-secret");
  if (!hasAuth) return NextResponse.json({ error: "Missing bearer token", code: "unauthorized" }, { status: 401 });
  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*", "/dashboard/:path*"] };
