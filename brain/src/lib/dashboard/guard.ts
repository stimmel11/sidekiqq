import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionSecretFromEnv, verifySession } from "./session";

/**
 * Edge-safe guard for the owner dashboard, called from src/middleware.ts.
 * Every /dashboard page and every server action posted to one (actions POST to the page URL)
 * requires a valid session cookie. Server actions re-check the session themselves as well.
 */

export const DASHBOARD_PREFIX = "/dashboard";
export const LOGIN_PATH = "/login";

export function isDashboardPath(pathname: string): boolean {
  return pathname === DASHBOARD_PREFIX || pathname.startsWith(`${DASHBOARD_PREFIX}/`);
}

/** Only same-site dashboard paths are allowed as a post-login destination (no open redirects). */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return DASHBOARD_PREFIX;
  try {
    const u = new URL(raw, "http://local");
    if (u.origin !== "http://local" || !isDashboardPath(u.pathname)) return DASHBOARD_PREFIX;
    return `${u.pathname}${u.search}`;
  } catch {
    return DASHBOARD_PREFIX;
  }
}

export async function dashboardGuard(req: NextRequest, env: Record<string, string | undefined> = process.env): Promise<NextResponse> {
  const ok = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, sessionSecretFromEnv(env));
  if (ok) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "private, no-store");
    res.headers.set("X-Frame-Options", "DENY");
    res.headers.set("Referrer-Policy", "same-origin");
    return res;
  }
  // Server actions and other non-GET requests get a plain 401 instead of a redirect.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return NextResponse.json({ error: "Owner session required", code: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = LOGIN_PATH;
  url.search = "";
  url.searchParams.set("next", `${req.nextUrl.pathname}${req.nextUrl.search}`);
  const res = NextResponse.redirect(url, 303);
  if (req.cookies.has(SESSION_COOKIE)) res.cookies.delete(SESSION_COOKIE);
  return res;
}
