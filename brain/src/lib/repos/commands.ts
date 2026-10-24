import type { KV } from "../kv";
import { DeviceCommandSchema, StoredCommandSchema, type CommandResult, type DeviceCommand, type DeviceKind, type StoredCommand } from "../models";
import { newId } from "../util";
import { Collection } from "./collection";
import { CommandError, COMMAND_TTL_SECONDS, MAX_PENDING_PER_DEVICE, OPENED_ACK_GRACE_SECONDS, type CommandFields } from "../commands";

/**
 * Per-device command queue (one Redis hash, filtered by target). Single-owner, so the table stays
 * small: commands expire after COMMAND_TTL_SECONDS, at most MAX_PENDING_PER_DEVICE are pending per
 * device, and rows older than a day (or past `maxRows`) are pruned.
 */
export class CommandsRepo {
  private readonly col: Collection<StoredCommand>;

  constructor(
    kv: KV,
    prefix: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly maxRows = 500,
  ) {
    this.col = new Collection(kv, prefix, "commands", StoredCommandSchema);
  }

  private isLive(c: StoredCommand, now: number) {
    return c.status === "pending" && Date.parse(c.expiresAt) > now;
  }

  async enqueue(fields: CommandFields, from: { id: string; kind: DeviceKind }, targetDeviceId: string): Promise<StoredCommand> {
    // Cap check + put is not atomic. Fine for a single owner: worst case one or two extra rows.
    const now = this.clock();
    const all = await this.col.all();
    const pending = all.filter((c) => c.targetDeviceId === targetDeviceId && this.isLive(c, now.getTime()));
    if (pending.length >= MAX_PENDING_PER_DEVICE) {
      throw new CommandError("that device already has too many commands waiting", "queue_full", 429);
    }
    const row = await this.col.put({
      ...fields,
      id: newId("cmd"),
      at: now.toISOString(),
      expiresAt: new Date(now.getTime() + COMMAND_TTL_SECONDS * 1000).toISOString(),
      from: from.kind,
      fromDeviceId: from.id,
      targetDeviceId,
      status: "pending",
    });
    // Prune occasionally, and only when the table is big enough for it to matter.
    if (all.length + 1 > this.maxRows / 2 && all.length % 25 === 0) await this.prune().catch(() => undefined);
    return row;
  }

  /** Pending, unexpired commands for one device, oldest first. */
  async pendingFor(deviceId: string, limit = 20): Promise<DeviceCommand[]> {
    const now = this.clock().getTime();
    return (await this.col.all())
      .filter((c) => c.targetDeviceId === deviceId && this.isLive(c, now))
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((c) => toContract(c));
  }

  /**
   * Record what the owner did with a command on its target device. Only the target may ack (others
   * get "not found"). Repeating the same result is a no-op; a different result is a conflict. An
   * expired command can still be dismissed or reported failed; "opened" is accepted up to
   * OPENED_ACK_GRACE_SECONDS after expiry (a slow ack for a tap made in time), then 410.
   */
  async ack(id: string, deviceId: string, result: CommandResult): Promise<StoredCommand> {
    const c = await this.col.get(id);
    if (!c || c.targetDeviceId !== deviceId) throw new CommandError("no such command", "not_found", 404);
    if (c.status === result) return c;
    if (c.status !== "pending") throw new CommandError(`command is already ${c.status}`, "already_acked", 409);
    const now = this.clock();
    if (result === "opened" && Date.parse(c.expiresAt) + OPENED_ACK_GRACE_SECONDS * 1000 <= now.getTime()) {
      throw new CommandError("command expired", "expired", 410);
    }
    return this.col.put({ ...c, status: result, ackedAt: now.toISOString() });
  }

  get(id: string) {
    return this.col.get(id);
  }

  /** Drop rows older than a day, and the oldest beyond `maxRows`. */
  async prune(): Promise<number> {
    const cutoff = this.clock().getTime() - 24 * 3_600_000;
    const rows = (await this.col.all()).sort((a, b) => b.at.localeCompare(a.at));
    const stale = rows.filter((c, i) => i >= this.maxRows || Date.parse(c.at) < cutoff);
    await Promise.all(stale.map((c) => this.col.delete(c.id)));
    return stale.length;
  }
}

/** Strip routing/delivery state before a command leaves the brain. */
export function toContract(c: StoredCommand): DeviceCommand {
  return DeviceCommandSchema.parse(c);
}
