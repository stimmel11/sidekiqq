import type { NextRequest } from "next/server";
import { getDeps, type Deps } from "./deps";
import { optional, required } from "./env";
import { safeEqual } from "./crypto";
import { bearerToken, errorResponse, HttpError } from "./http";
import type { DeviceRecord } from "./models";

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
