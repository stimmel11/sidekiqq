import type { NextRequest } from "next/server";
import { getDeps, type Deps } from "./deps";
import { optional, required } from "./env";
import { safeEqual } from "./crypto";
import { bearerToken, errorResponse, HttpError } from "./http";
import type { DeviceRecord } from "./models";
import { SESSION_COOKIE, sessionSecretFromEnv, verifySession } from "./dashboard/session";
import { dashboardWebDevice } from "./dashboard/device-bridge";

/**
 * Auth middleware for route handlers. Next's edge `middleware.ts` only checks that a
 * bearer header is present; the real verification (hash lookup in Redis, revocation)
 * happens here in the Node runtime.
 */

export async function authenticateDevice(req: Request, deps: Deps = getDeps()): Promise<DeviceRecord> {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "Missing bearer token", "unauthorized");
  if (token.length > 512) throw new HttpError(401, "Invalid token", "unauthorized");
  const device = await deps.repos.devices.findByToken(token);
  if (!device) throw new HttpError(401, "Invalid or revoked device token", "unauthorized");
  deps.repos.devices.touch(device.id).catch(() => undefined);
  return device;
}

export function isOwnerSecret(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const secret = required("OWNER_SECRET");
  if (secret.length < 16) throw new Error("OWNER_SECRET must be at least 16 characters");
  return safeEqual(candidate, secret);
}

/** Owner-only endpoints: `Authorization: Bearer <OWNER_SECRET>` or `X-Owner-Secret`. */
export function requireOwner(req: Request): void {
  const candidate = req.headers.get("x-owner-secret") ?? bearerToken(req);
  if (!isOwnerSecret(candidate)) throw new HttpError(401, "Owner authentication required", "unauthorized");
}

function cookieValue(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/**
 * Owner endpoints that the dashboard also calls (docs/CONNECTORS.md §9): the owner secret header,
 * or a valid dashboard session cookie. A paired device token is never enough. If any header
 * credential is sent it must be the owner secret (a device token plus a cookie is refused). For
 * cookie auth on writes, a cross-site `Origin`/`Sec-Fetch-Site` is refused on top of SameSite=Strict.
 */
export async function requireOwnerOrSession(req: Request, env: Record<string, string | undefined> = process.env): Promise<"secret" | "session"> {
  const header = req.headers.get("x-owner-secret") ?? bearerToken(req);
  if (header !== null) {
    if (!isOwnerSecret(header)) throw new HttpError(401, "Owner authentication required", "unauthorized");
    return "secret";
  }
  if (!(await verifySession(cookieValue(req, SESSION_COOKIE), sessionSecretFromEnv(env)))) {
    throw new HttpError(401, "Owner authentication required", "unauthorized");
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const site = req.headers.get("sec-fetch-site");
    const origin = req.headers.get("origin");
    if ((site && site !== "same-origin") || (origin && origin !== new URL(req.url).origin)) {
      throw new HttpError(403, "Cross-site request refused", "cross_site");
    }
  }
  return "session";
}

/**
 * Fail-closed CSRF check for session-authenticated device routes (docs/WEBAPP.md §4): on every
 * non-GET the browser must say the request is same-origin. A cross-site `Sec-Fetch-Site` or
 * `Origin` is refused, and so is a request that carries neither header (unlike
 * requireOwnerOrSession, which lets that through). Every browser that can hold the
 * SameSite=Strict session cookie sends at least one of them on a POST.
 */
export function requireSameOrigin(req: Request): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  if (site === null && origin === null) throw new HttpError(403, "Same-origin request required", "cross_site");
  if (site !== null && site !== "same-origin") throw new HttpError(403, "Cross-site request refused", "cross_site");
  if (origin !== null && origin !== new URL(req.url).origin) throw new HttpError(403, "Cross-site request refused", "cross_site");
}

/** Who is calling a device route: a paired device's token, or the owner's dashboard session. */
export type Principal = { via: "device" | "session"; device: DeviceRecord };

/**
 * `withPrincipal` auth (docs/WEBAPP.md §4.2). An `Authorization` header means a device token and
 * nothing else (a cookie next to it is ignored; the owner secret is not a device token). With no
 * `Authorization` header, a valid dashboard session cookie plus the fail-closed same-origin check
 * yields the owner's `web` device. Session callers get extra checks in the routes that need them
 * (the approve route requires the confirmation fingerprint).
 */
export async function authenticatePrincipal(
  req: Request,
  deps: Deps = getDeps(),
  opts: { env?: Record<string, string | undefined>; key?: Buffer } = {},
): Promise<Principal> {
  if (req.headers.has("authorization")) return { via: "device", device: await authenticateDevice(req, deps) };
  if (!(await verifySession(cookieValue(req, SESSION_COOKIE), sessionSecretFromEnv(opts.env ?? process.env)))) {
    throw new HttpError(401, "Missing bearer token", "unauthorized");
  }
  requireSameOrigin(req);
  const device = await dashboardWebDevice(deps, opts.key);
  deps.repos.devices.touch(device.id).catch(() => undefined);
  return { via: "session", device };
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; `X-Cron-Secret` is accepted for manual runs. */
export function requireCron(req: Request): void {
  const secret = optional("CRON_SECRET");
  if (!secret) throw new HttpError(503, "CRON_SECRET is not configured", "not_configured");
  const candidate = req.headers.get("x-cron-secret") ?? bearerToken(req);
  if (!candidate || !safeEqual(candidate, secret)) throw new HttpError(401, "Invalid cron secret", "unauthorized");
}

type RouteCtx<P> = { params: Promise<P> };

/**
 * Wrap a route handler with device auth + uniform error handling.
 * `export const POST = withDevice(async (req, { device, deps, params }) => ...)`
 */
export function withDevice<P = Record<string, never>>(
  handler: (req: NextRequest, ctx: { device: DeviceRecord; deps: Deps; params: P }) => Promise<Response>,
) {
  return async (req: NextRequest, ctx: RouteCtx<P>): Promise<Response> => {
    try {
      const deps = getDeps();
      const device = await authenticateDevice(req, deps);
      const params = ctx?.params ? await ctx.params : ({} as P);
      return await handler(req, { device, deps, params });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/**
 * Like withDevice, but also accepts the owner's dashboard session (see authenticatePrincipal).
 * `principal.via` tells the handler which one; `device` is the device token's record or the
 * owner's `web` device. Only routes listed in middleware's `PRINCIPAL_ROUTES` receive cookies.
 */
export function withPrincipal<P = Record<string, never>>(
  handler: (req: NextRequest, ctx: { device: DeviceRecord; principal: Principal; deps: Deps; params: P }) => Promise<Response>,
) {
  return async (req: NextRequest, ctx: RouteCtx<P>): Promise<Response> => {
    try {
      const deps = getDeps();
      const principal = await authenticatePrincipal(req, deps);
      const params = ctx?.params ? await ctx.params : ({} as P);
      return await handler(req, { device: principal.device, principal, deps, params });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Owner secret header or dashboard session (see requireOwnerOrSession), with uniform errors. `no-store` on every reply. */
export function withOwnerOrSession<P = Record<string, never>>(handler: (req: NextRequest, ctx: { deps: Deps; params: P }) => Promise<Response>) {
  return async (req: NextRequest, ctx: RouteCtx<P>): Promise<Response> => {
    let res: Response;
    try {
      await requireOwnerOrSession(req);
      const params = ctx?.params ? await ctx.params : ({} as P);
      res = await handler(req, { deps: getDeps(), params });
    } catch (err) {
      res = errorResponse(err);
    }
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
}

/**
 * Same as withDevice but for owner-secret endpoints. The context is required (as in withDevice):
 * `next build` rejects an optional second argument on route exports.
 */
export function withOwner<P = Record<string, never>>(handler: (req: NextRequest, ctx: { deps: Deps; params: P }) => Promise<Response>) {
  return async (req: NextRequest, ctx: RouteCtx<P>): Promise<Response> => {
    try {
      requireOwner(req);
      const params = ctx?.params ? await ctx.params : ({} as P);
      return await handler(req, { deps: getDeps(), params });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
