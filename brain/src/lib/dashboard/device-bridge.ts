import { NextRequest } from "next/server";
import { decrypt, encrypt, encryptionKeyFromEnv } from "../crypto";
import type { Deps } from "../deps";
import { config } from "../env";
import type { DeviceRecord } from "../models";

/**
 * The dashboard performs device actions (approve / discard a draft, complete a commitment) by
 * invoking the EXISTING route handlers in-process, so there is exactly one implementation of each,
 * and in particular exactly one send path: POST /api/drafts/:id/approve.
 *
 * Those handlers authenticate a paired device, so the dashboard holds its own device token: a
 * device of kind "web" named "Owner web dashboard", created on first use (never paired with a
 * code). Its plaintext token is kept only server-side, AES-256-GCM encrypted in Redis with
 * TOKEN_ENCRYPTION_KEY. Revoking that device simply makes the dashboard mint a new one.
 *
 * Before the `web` kind existed this device was kind "phone", so phone hand-offs could be queued
 * for it although it never polls. A stored legacy device is revoked and replaced by a `web` one
 * (docs/WEBAPP.md §4.2). This bridge goes away once `withPrincipal` lands (web app slice 2).
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
      const device = await deps.repos.devices.findByToken(token);
      if (device?.kind === "web") return token;
    } catch {
      // Key rotated or value corrupt: fall through and mint a fresh device.
    }
  }
  const { device, token } = await deps.repos.devices.create("web", DASHBOARD_DEVICE_NAME);
  await deps.kv.set(storeKey(), encrypt(token, key, AAD));
  // Retire legacy "phone" dashboard devices (also ones whose stored token could no longer be
  // decrypted), so no phone hand-off is routed to a device that never polls. Pairing can't create
  // a kind-phone device without a code, and only this bridge creates ones of kind web.
  for (const d of await deps.repos.devices.list()) {
    if (d.id !== device.id && !d.revoked && d.kind === "phone" && d.name === DASHBOARD_DEVICE_NAME) await deps.repos.devices.revoke(d.id);
  }
  return token;
}

/**
 * The owner's `web` device record, for a request authenticated by the dashboard session
 * (`withPrincipal` in lib/auth.ts). Today every signed-in browser shares this one device; one
 * `web` device per browser comes with v2 sessions (docs/WEBAPP.md §4.1–4.2).
 */
export async function dashboardWebDevice(deps: Deps, key?: Buffer): Promise<DeviceRecord> {
  const device = await deps.repos.devices.findByToken(await dashboardDeviceToken(deps, key));
  // Just minted or verified above; a concurrent revoke is the only way to get here.
  if (!device || device.kind !== "web") throw new Error("Dashboard web device is unavailable");
  return device;
}

type RouteHandler<P> =(req: NextRequest, ctx: { params: Promise<P> }) => Promise<Response>;

export interface RouteResult {
  status: number;
  body: { ok?: boolean; error?: string; code?: string } & Record<string, unknown>;
}

export interface BridgeBody {
  /** Raw bytes (e.g. a WAV for /api/transcribe) or a JSON-serialisable value. */
  bytes?: Uint8Array;
  json?: unknown;
  contentType?: string;
}

/**
 * Call an existing device-authenticated route handler as the dashboard device and return its raw
 * Response (used for /api/speak, whose reply is audio/wav).
 */
export async function requestAsDashboardDevice<P extends Record<string, string>>(
  deps: Deps,
  handler: RouteHandler<P>,
  path: string,
  params: P,
  key?: Buffer,
  body?: BridgeBody,
): Promise<Response> {
  const token = await dashboardDeviceToken(deps, key);
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let payload: BodyInit | undefined;
  if (body?.bytes) {
    payload = body.bytes as BodyInit;
    headers["content-type"] = body.contentType ?? "application/octet-stream";
    headers["content-length"] = String(body.bytes.byteLength);
  } else if (body && "json" in body) {
    payload = JSON.stringify(body.json);
    headers["content-type"] = body.contentType ?? "application/json";
  }
  const req = new NextRequest(new URL(path, config.appUrl()), { method: "POST", headers, body: payload });
  return handler(req, { params: Promise.resolve(params) });
}

/** Call an existing device-authenticated route handler as the dashboard device. */
export async function callAsDashboardDevice<P extends Record<string, string>>(
  deps: Deps,
  handler: RouteHandler<P>,
  path: string,
  params: P,
  key?: Buffer,
  body?: BridgeBody,
): Promise<RouteResult> {
  const res = await requestAsDashboardDevice(deps, handler, path, params, key, body);
  let parsed: RouteResult["body"] = {};
  try {
    parsed = (await res.json()) as RouteResult["body"];
  } catch {
    // non-JSON body; status is enough
  }
  return { status: res.status, body: parsed };
}
