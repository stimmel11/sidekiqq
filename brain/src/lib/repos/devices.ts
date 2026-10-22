import type { KV } from "../kv";
import { DeviceRecordSchema, type DeviceKind, type DeviceRecord } from "../models";
import { randomToken, sha256 } from "../crypto";
import { newId } from "../util";
import { Collection } from "./collection";

/**
 * Paired devices. Only a SHA-256 hash of each bearer token is stored; a lookup index
 * `<prefix>:devtok:<hash>` -> deviceId makes auth O(1).
 */
export class DevicesRepo {
  private readonly col: Collection<DeviceRecord>;
  constructor(
    private readonly kv: KV,
    private readonly prefix: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.col = new Collection(kv, prefix, "devices", DeviceRecordSchema);
  }

  private tokenKey(hash: string) {
    return `${this.prefix}:devtok:${hash}`;
  }

  /** Create a device and return its plaintext token (shown once, never stored). */
  async create(kind: DeviceKind, name?: string): Promise<{ device: DeviceRecord; token: string }> {
    const token = `skq_${randomToken(32)}`;
    const tokenHash = sha256(token);
    const device = await this.col.put({
      id: newId("dev"),
      kind,
      ...(name ? { name } : {}),
      tokenHash,
      createdAt: this.clock().toISOString(),
      revoked: false,
    });
    await this.kv.set(this.tokenKey(tokenHash), device.id);
    return { device, token };
  }

  async findByToken(token: string): Promise<DeviceRecord | null> {
    const id = await this.kv.get(this.tokenKey(sha256(token)));
    if (!id) return null;
    const device = await this.col.get(id);
    if (!device || device.revoked || device.tokenHash !== sha256(token)) return null;
    return device;
  }

  get(id: string) {
    return this.col.get(id);
  }

  list() {
    return this.col.all();
  }

  async touch(id: string): Promise<void> {
    const d = await this.col.get(id);
    if (!d) return;
    // Avoid a write on every request: refresh at most every 5 minutes.
    if (d.lastSeenAt && Date.now() - Date.parse(d.lastSeenAt) < 5 * 60_000) return;
    await this.col.put({ ...d, lastSeenAt: this.clock().toISOString() });
  }

  async setFcmToken(id: string, fcmToken: string, fcmDevice: string): Promise<DeviceRecord | null> {
    const d = await this.col.get(id);
    if (!d) return null;
    return this.col.put({ ...d, fcmToken, fcmDevice });
  }

  async clearFcmToken(fcmToken: string): Promise<void> {
    for (const d of await this.col.all()) {
      if (d.fcmToken === fcmToken) {
        const { fcmToken: _t, fcmDevice: _d, ...rest } = d;
        await this.col.put(rest);
      }
    }
  }

  async revoke(id: string): Promise<boolean> {
    const d = await this.col.get(id);
    if (!d) return false;
    await this.col.put({ ...d, revoked: true });
    await this.kv.del(this.tokenKey(d.tokenHash));
    return true;
  }

  async pushTokens(): Promise<string[]> {
    return (await this.col.all()).filter((d) => !d.revoked && d.fcmToken).map((d) => d.fcmToken as string);
  }
}
