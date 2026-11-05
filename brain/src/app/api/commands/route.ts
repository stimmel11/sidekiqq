import { withDevice } from "@/lib/auth";
import { HttpError, json, parseJson } from "@/lib/http";
import { buildCommand, resolveTarget } from "@/lib/commands";
import { nudgeCommandTarget } from "@/lib/commands/nudge";
import { toContract } from "@/lib/repos/commands";
import { CommandsResponseSchema, CreateCommandRequestSchema, CreateCommandResponseSchema } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/commands — queue a command started on this device to run on another one
 * (default target: the most recently seen device that can run it, e.g. the phone for a call).
 * Commands are hand-offs: the target shows the label and the owner taps. Nothing is sent.
 * The target then gets a silent FCM nudge (`kind: "command"`, id only) so it polls right away;
 * polling stays the delivery guarantee.
 */
export const POST = withDevice(async (req, { device, deps }) => {
  const body = await parseJson(req, CreateCommandRequestSchema);
  const fields = buildCommand(body);
  const target = resolveTarget(body.kind, body.target, await deps.repos.devices.list());
  const row = await deps.repos.commands.enqueue(fields, { id: device.id, kind: device.kind }, target.id);
  await nudgeCommandTarget(deps, target, row.id);
  return json(CreateCommandResponseSchema.parse({ command: toContract(row), deviceId: target.id, device: target.kind }), { status: 201 });
});

/**
 * GET /api/commands?limit=<1..50> — this device's pending, unexpired commands, oldest first.
 * A command stays here until the device acks it (POST /api/commands/:id/ack) or it expires,
 * so devices should dedupe by `id` while one is on screen.
 */
export const GET = withDevice(async (req, { device, deps }) => {
  const rawLimit = req.nextUrl.searchParams.get("limit");
  if (rawLimit !== null && !/^\d{1,2}$/.test(rawLimit)) throw new HttpError(400, "limit must be 1-50");
  const limit = rawLimit ? Number(rawLimit) : 20;
  if (limit < 1 || limit > 50) throw new HttpError(400, "limit must be 1-50");
  const items = await deps.repos.commands.pendingFor(device.id, limit);
  return json(CommandsResponseSchema.parse({ items }), { headers: { "Cache-Control": "no-store" } });
});
