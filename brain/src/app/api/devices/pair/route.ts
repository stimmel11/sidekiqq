import { z } from "zod";
import { errorResponse, HttpError, json, parseJson, clientIp } from "@/lib/http";
import { getDeps } from "@/lib/deps";
import { DeviceKindSchema } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "code must be 6 digits"),
  device: DeviceKindSchema,
  name: z.string().trim().min(1).max(64).optional(),
});

const MAX_ATTEMPTS_PER_WINDOW = 10;

/**
 * Unauthenticated by design (this is how a device obtains its token).
 * Exchanges a one-time pairing code for a long-lived device bearer token.
 * Codes are single-use (atomic GETDEL) and attempts are rate-limited per IP.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const deps = getDeps();
    const attempts = await deps.repos.pairing.recordAttempt(clientIp(req));
    if (attempts > MAX_ATTEMPTS_PER_WINDOW) throw new HttpError(429, "Too many pairing attempts; try again later", "rate_limited");

    const body = await parseJson(req, Body);
    const consumed = await deps.repos.pairing.consume(body.code);
    if (!consumed) throw new HttpError(401, "Invalid or expired pairing code", "invalid_code");

    const { device, token } = await deps.repos.devices.create(body.device, body.name ?? consumed.label ?? undefined);
    return json({ token, deviceId: device.id, device: device.kind });
  } catch (err) {
    return errorResponse(err);
  }
}
