import { withDevice } from "@/lib/auth";
import { HttpError, json, parseJson } from "@/lib/http";
import { RegisterDeviceSchema } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Attach/refresh the calling (already paired) device's push target.
 *  - `transport: "fcm"` (the default; native apps send `{ fcmToken, device }`): any device except
 *    `web`. Browsers never get FCM, so silent command nudges can't reach them.
 *  - `transport: "webpush"` (docs/WEBAPP.md §5): `web` devices only. The endpoint must be on the
 *    browser push-service allowlist (checked by the schema; 400 otherwise). It replaces this
 *    device's previous subscription and is taken off any other device that held it.
 */
export const POST = withDevice(async (req, { deps, device }) => {
  const body = await parseJson(req, RegisterDeviceSchema);
  if (body.transport === "webpush") {
    if (device.kind !== "web") throw new HttpError(400, "Web Push is only for browsers", "transport_not_allowed");
    if (!deps.webPush().enabled) throw new HttpError(503, "Web Push is not configured on this brain", "webpush_disabled");
    await deps.webPushSubs.set(device.id, body.subscription);
    return json({ ok: true as const });
  }
  if (device.kind === "web") throw new HttpError(400, "Browsers register with transport \"webpush\"", "transport_not_allowed");
  const updated = await deps.repos.devices.setFcmToken(device.id, body.fcmToken, body.device);
  if (!updated) throw new HttpError(404, "Device not found", "not_found");
  return json({ ok: true as const });
});
