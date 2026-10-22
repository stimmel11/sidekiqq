import type { KV } from "../kv";
import { z } from "zod";
import { TopItemSchema, type TopItem } from "../models";

/** Small singleton documents: scan cursor, cached Top-5, alert de-dup markers. */
export class StateRepo {
  constructor(private readonly kv: KV, private readonly prefix: string) {}

  async getLastScan(): Promise<{ at: string; historyId?: string } | null> {
    const raw = await this.kv.get(`${this.prefix}:state:lastScan`);
    if (!raw) return null;
    const parsed = z.object({ at: z.string(), historyId: z.string().optional() }).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  async setLastScan(v: { at: string; historyId?: string }): Promise<void> {
    await this.kv.set(`${this.prefix}:state:lastScan`, JSON.stringify(v));
  }

  /** Mark a Gmail message processed. Returns false if already processed. */
  async markMessageProcessed(messageId: string): Promise<boolean> {
    return this.kv.set(`${this.prefix}:seen:msg:${messageId}`, "1", { nx: true, exSeconds: 60 * 60 * 24 * 30 });
  }

  async isMessageProcessed(messageId: string): Promise<boolean> {
    return (await this.kv.get(`${this.prefix}:seen:msg:${messageId}`)) !== null;
  }

  async unmarkMessageProcessed(messageId: string): Promise<void> {
    await this.kv.del(`${this.prefix}:seen:msg:${messageId}`);
  }

  /** Alert at most once per key per `ttlSeconds`. Returns true if the alert should fire. */
  async claimAlert(key: string, ttlSeconds = 60 * 60 * 24): Promise<boolean> {
    return this.kv.set(`${this.prefix}:alerted:${key}`, "1", { nx: true, exSeconds: ttlSeconds });
  }

  async getTop5(): Promise<{ items: TopItem[]; updatedAt: string } | null> {
    const raw = await this.kv.get(`${this.prefix}:state:top5`);
    if (!raw) return null;
    const parsed = z.object({ items: z.array(TopItemSchema), updatedAt: z.string() }).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  }

  async setTop5(v: { items: TopItem[]; updatedAt: string }, ttlSeconds = 60 * 60): Promise<void> {
    await this.kv.set(`${this.prefix}:state:top5`, JSON.stringify(v), { exSeconds: ttlSeconds });
  }

  async invalidateTop5(): Promise<void> {
    await this.kv.del(`${this.prefix}:state:top5`);
  }
}
