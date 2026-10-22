import { NextRequest } from "next/server";
import { decrypt, encrypt, encryptionKeyFromEnv } from "../crypto";
import type { Deps } from "../deps";
import { config } from "../env";

/**
 * The dashboard performs device actions (approve / discard a draft, complete a commitment) by
 * invoking the EXISTING route handlers in-process, so there is exactly one implementation of each,
 * and in particular exactly one send path: POST /api/drafts/:id/approve.
 *
 * Those handlers authenticate a paired device, so the dashboard holds its own device token: a
 * normal paired device (kind "phone", name "Owner web dashboard") created on first use. Its
 * plaintext token is kept only server-side, AES-256-GCM encrypted in Redis with
 * TOKEN_ENCRYPTION_KEY. Revoking that device simply makes the dashboard mint a new one.
 */

export const DASHBOARD_DEVICE_NAME = "Owner web dashboard";
const AAD = "dashboard-device-token";

function storeKey() {
  return `${config.redisPrefix()}:dashboard:device-token`;
}

export async function dashboardDeviceToken(deps: Deps, key: Buffer = encryptionKeyFromEnv()): Promise<string> {
  const stored = await deps.kv.get(storeKey());
  if (stored) {
    try {
      const token = decrypt(stored, key, AAD);
      if (await deps.repos.devices.findByToken(token)) return token;
    } catch {
      // Key rotated or value corrupt: fall through and mint a fresh device.
    }
  }
  const { token } = await deps.repos.devices.create("phone", DASHBOARD_DEVICE_NAME);
  await deps.kv.set(storeKey(), encrypt(token, key, AAD));
  return token;
}

type RouteHandler<P> = (req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;

export interface RouteResult {
  status: number;
  body: { ok?: boolean; error?: string; code?: string } & Record<string, unknown>;
}

/** Call an existing device-authenticated route handler as the dashboard device. */
export async function callAsDashboardDevice<P extends Record<string, string>>(
  deps: Deps,
  handler: RouteHandler<P>,
  path: string,
  params: P,
  key?: Buffer,
): Promise<RouteResult> {
  const token = await dashboardDeviceToken(deps, key);
  const req = new NextRequest(new URL(path, config.appUrl()), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const res = await handler(req, { params: Promise.resolve(params) });
  let body: RouteResult["body"] = {};
  try {
    body = (await res.json()) as RouteResult["body"];
  } catch {
    // non-JSON body; status is enough
  }
  return { status: res.status, body };
}
