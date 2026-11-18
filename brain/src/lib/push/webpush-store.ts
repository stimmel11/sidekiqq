import type { KV } from "../kv";
import { decrypt, encrypt, sha256 } from "../crypto";
import { WebPushSubscriptionSchema, type WebPushSubscription } from "../models";
import type { KeyRing } from "../connectors/store";

/**
 * Web Push subscriptions, one per `web` device (docs/WEBAPP.md §5).
 *
 *  - `<prefix>:webpush:dev:<deviceId>` holds the subscription (endpoint + keys) sealed with
 *    AES-256-GCM under TOKEN_ENCRYPTION_KEY, bound to the device id by the AAD. The endpoint is a
 *    capability URL and `keys.auth` is a secret, so neither sits in KV in the clear. (Accounts
 *    slice A4 moves this to the tenant DEK.)
 *  - `<prefix>:webpush:ep:<sha256(endpoint)>` → deviceId, so one browser subscription belongs to one
 *    device: registering it on device B clears it from device A. (Accounts slice A2 turns this into
 *    the global `g:push:` index across tenants.)
 *  - `<prefix>:webpush:backoff:<sha256(endpoint)>` exists while a push service has asked us to slow
 *    down (429); its TTL is the Retry-After.
 */
export class WebPushStore {
  constructor(
    private readonly kv: KV,
    private readonly prefix: string,
    private readonly keys: () => KeyRing,
  ) {}

  private devKey(deviceId: string) {
    return `${this.prefix}:webpush:dev:${deviceId}`;
  }
  private epKey(endpoint: string) {
    return `${this.prefix}:webpush:ep:${sha256(endpoint)}`;
  }
  private backoffKey(endpoint: string) {
    return `${this.prefix}:webpush:backoff:${sha256(endpoint)}`;
  }
  private aad(deviceId: string) {
    return `webpush:${deviceId}`;
  }

  async get(deviceId: string): Promise<WebPushSubscription | null> {
    const sealed = await this.kv.get(this.devKey(deviceId));
    if (!sealed) return null;
    const ring = this.keys();
    let plain: string;
    try {
      plain = decrypt(sealed, ring.current, this.aad(deviceId));
    } catch (err) {
      if (!ring.previous) {
        console.error(`[webpush] subscription for ${deviceId} could not be decrypted; the browser must turn alerts on again`, (err as Error)?.message);
        return null;
      }
      try {
        plain = decrypt(sealed, ring.previous, this.aad(deviceId));
      } catch (err2) {
        console.error(`[webpush] subscription for ${deviceId} could not be decrypted; the browser must turn alerts on again`, (err2 as Error)?.message);
        return null;
      }
    }
    try {
      const parsed = WebPushSubscriptionSchema.safeParse(JSON.parse(plain));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Store `sub` on `deviceId`, taking it away from any other device that held the same endpoint. */
  async set(deviceId: string, sub: WebPushSubscription): Promise<void> {
    const clean = WebPushSubscriptionSchema.parse(sub);
    const holder = await this.kv.get(this.epKey(clean.endpoint));
    if (holder && holder !== deviceId) await this.kv.del(this.devKey(holder));
    const previous = await this.get(deviceId);
    if (previous && previous.endpoint !== clean.endpoint) {
      const prevHolder = await this.kv.get(this.epKey(previous.endpoint));
      if (prevHolder === deviceId) await this.kv.del(this.epKey(previous.endpoint));
    }
    await this.kv.set(this.devKey(deviceId), encrypt(JSON.stringify(clean), this.keys().current, this.aad(deviceId)));
    await this.kv.set(this.epKey(clean.endpoint), deviceId);
  }

  /** Forget this device's subscription (revoked device, or the browser turned alerts off). */
  async clear(deviceId: string): Promise<void> {
    const sub = await this.get(deviceId);
    await this.kv.del(this.devKey(deviceId));
    if (sub && (await this.kv.get(this.epKey(sub.endpoint))) === deviceId) await this.kv.del(this.epKey(sub.endpoint));
  }

  /**
   * The push service said this subscription is gone (404/410). Clears it only while `deviceId` still
   * holds exactly this endpoint, so a fresh subscription registered meanwhile is kept.
   */
  async clearIfEndpoint(deviceId: string, endpoint: string): Promise<boolean> {
    const sub = await this.get(deviceId);
    if (!sub || sub.endpoint !== endpoint) return false;
    await this.clear(deviceId);
    return true;
  }

  async backingOff(endpoint: string): Promise<boolean> {
    return (await this.kv.get(this.backoffKey(endpoint))) !== null;
  }

  async backOff(endpoint: string, seconds: number): Promise<void> {
    await this.kv.set(this.backoffKey(endpoint), "1", { exSeconds: seconds });
  }
}
