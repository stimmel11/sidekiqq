import { decrypt, encrypt, encryptionKeyFromEnv } from "../crypto";
import type { Deps } from "../deps";
import type { DeviceRecord } from "../models";

/**
 * The owner's `web` device: the device record a signed-in dashboard session acts as
 * (`withPrincipal` in lib/auth.ts, docs/WEBAPP.md §4.2). Every dashboard call now goes from the
 * browser to the API routes as the session; nothing calls a route handler in-process any more
 * (the old device bridge was removed in slice 2c-ii-b-ii).
 *
 * The device is kind "web", named "Owner web dashboard", created on first use (never paired with
 * a code). Its token is kept only server-side, AES-256-GCM encrypted under the tenant's prefix
 * with TOKEN_ENCRYPTION_KEY, so it can be looked up again; revoking the device makes the next
 * session request mint a new one. Today every signed-in browser shares it; one `web` device per
 * browser comes with v2 sessions (§4.1–4.2).
 *
 * Before the `web` kind existed this device was kind "phone", so phone hand-offs could be queued
 * for it although it never polls. A stored legacy device is revoked and replaced by a `web` one.
 */

export const DASHBOARD_DEVICE_NAME = "Owner web dashboard";
const AAD = "dashboard-device-token";

function storeKey(deps: Deps) {
  return `${deps.tenant.prefix}:dashboard:device-token`;
}

/** The shared dashboard `web` device and its token, minting (and storing) one when needed. */
export async function dashboardDevice(deps: Deps, key: Buffer = encryptionKeyFromEnv()): Promise<{ token: string; device: DeviceRecord }> {
  const stored = await deps.kv.get(storeKey(deps));
  if (stored) {
    try {
      const token = decrypt(stored, key, AAD);
      const device = await deps.repos.devices.findByToken(token);
      if (device?.kind === "web") return { token, device };
    } catch {
      // Key rotated or value corrupt: fall through and mint a fresh device.
    }
  }
  const { device, token } = await deps.repos.devices.create("web", DASHBOARD_DEVICE_NAME);
  await deps.kv.set(storeKey(deps), encrypt(token, key, AAD));
  // Retire legacy "phone" dashboard devices (also ones whose stored token could no longer be
  // decrypted), so no phone hand-off is routed to a device that never polls. Pairing can't create
  // a kind-phone device without a code, and only this module creates ones of kind web.
  for (const d of await deps.repos.devices.list()) {
    if (d.id !== device.id && !d.revoked && d.kind === "phone" && d.name === DASHBOARD_DEVICE_NAME) await deps.repos.devices.revoke(d.id);
  }
  return { token, device };
}

/** Just the token (tests and tools that need to call a route as this device). */
export async function dashboardDeviceToken(deps: Deps, key?: Buffer): Promise<string> {
  return (await dashboardDevice(deps, key)).token;
}

/** The owner's `web` device record for a request authenticated by the dashboard session. */
export async function dashboardWebDevice(deps: Deps, key?: Buffer): Promise<DeviceRecord> {
  return (await dashboardDevice(deps, key)).device;
}
