import { withDevice } from "@/lib/auth";
import { HttpError, json, parseJson } from "@/lib/http";
import { RegisterDeviceSchema } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Attach/refresh the FCM token for the calling (already paired) device. */
export const POST = withDevice(async (req, { deps, device }) => {
  const body = await parseJson(req, RegisterDeviceSchema);
  const updated = await deps.repos.devices.setFcmToken(device.id, body.fcmToken, body.device);
  if (!updated) throw new HttpError(404, "Device not found", "not_found");
  return json({ ok: true as const });
});
