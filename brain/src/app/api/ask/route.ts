import { runAsk } from "@/lib/assistant/ask";
import { withDevice } from "@/lib/auth";
import { json, parseJson } from "@/lib/http";
import { AskRequestSchema, AskResponseSchema } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = withDevice(async (req, { device, deps }) => {
  const body = await parseJson(req, AskRequestSchema);
  const result = await runAsk(deps, body, { deviceId: device.id, deviceKind: device.kind });
  return json(AskResponseSchema.parse(result));
});
