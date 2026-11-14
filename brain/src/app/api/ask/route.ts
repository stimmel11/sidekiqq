import { runAsk } from "@/lib/assistant/ask";
import { withDevice } from "@/lib/auth";
import { HttpError, json, parseJson } from "@/lib/http";
import { ASK_DEVICE_RELAYS, AskRequestSchema, AskResponseSchema } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withDevice(async (req, { device, deps }) => {
  const body = await parseJson(req, AskRequestSchema);
  // The prompt is told `body.device`, the tools use the authenticated kind: they must agree
  // (allowing only the phone's relays for its medallion and glasses). docs/WEBAPP.md §6.2.
  if (!ASK_DEVICE_RELAYS[device.kind].includes(body.device)) {
    throw new HttpError(400, `a ${device.kind} can't ask as ${body.device}`, "device_mismatch");
  }
  const result = await runAsk(deps, body, { deviceId: device.id, deviceKind: device.kind });
  return json(AskResponseSchema.parse(result));
});
