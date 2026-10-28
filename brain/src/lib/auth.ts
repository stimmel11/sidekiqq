import type { NextRequest } from "next/server";
import { getDeps, type Deps } from "./deps";
import { optional, required } from "./env";
import { safeEqual } from "./crypto";
import { bearerToken, errorResponse, HttpError } from "./http";
import type { DeviceRecord } from "./models";
import { SESSION_COOKIE, sessionSecretFromEnv, verifySession } from "./dashboard/session";

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

/** Same as withDevice but for owner-secret endpoints. */
export function withOwner(handler: (req: NextRequest, ctx: { deps: Deps }) => Promise<Response>) {
  return async (req: NextRequest): Promise<Response> => {
    try {
      requireOwner(req);
      return await handler(req, { deps: getDeps() });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
