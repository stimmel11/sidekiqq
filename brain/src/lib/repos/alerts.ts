import type { KV } from "../kv";
import { AlertSchema, type Alert } from "../models";
import { Collection } from "./collection";

/**
 * Short, bounded log of proactive alerts (the same content the FCM push carries), so devices
 * without FCM (Reachy Mini) can poll `GET /api/alerts?since=<cursor>`.
 *
 * Every alert gets a monotonic sequence number from a Redis counter. The cursor a device holds is
 * simply the last sequence number it has seen. The log keeps at most `maxRows` rows and drops rows
 * older than `retentionDays`, so a poll's HGETALL stays small.
 */
export type NewAlert = Omit<Alert, "id" | "at">;

export interface AlertPage {
  items: Alert[];
  cursor: string;
  more: boolean;
}

export class AlertsRepo {
  private readonly col: Collection<Alert>;
  private readonly seqKey: string;

  constructor(
    private readonly kv: KV,
    prefix: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly retentionDays = 7,
    private readonly maxRows = 500,
  ) {
    this.col = new Collection(kv, prefix, "alerts", AlertSchema);
    this.seqKey = `${prefix}:alerts:seq`;
  }

  /** The newest sequence number (0 if nothing was ever logged). */
  async latestSeq(): Promise<number> {
    const raw = await this.kv.get(this.seqKey);
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  async add(alert: NewAlert): Promise<Alert> {
    // ~10-year TTL: incrWithTtl only sets it on the first increment, so the counter is effectively permanent.
    const seq = await this.kv.incrWithTtl(this.seqKey, 60 * 60 * 24 * 3650);
    const row = await this.col.put({ ...alert, id: String(seq), at: this.clock().toISOString() });
    if (seq % 25 === 0) await this.prune().catch(() => undefined);
    return row;
  }

  /**
   * Alerts newer than `since`, oldest first, at most `limit`.
   * - No cursor: alerts from the last 24 h (a newly paired device gets today's context, not a week's).
   * - A cursor ahead of the counter (e.g. the store was reset): treated like no cursor.
   */
  async since(since: number | null, limit = 50): Promise<AlertPage> {
    const latest = await this.latestSeq();
    const now = this.clock().getTime();
    const fresh = since === null || since > latest;
    const floor = fresh ? 0 : since;
    const rows = (await this.col.all())
      .filter((a) => Number(a.id) > floor)
      .filter((a) => !fresh || now - Date.parse(a.at) <= 24 * 3_600_000)
      .sort((a, b) => Number(a.id) - Number(b.id));
    const items = rows.slice(0, limit);
    const more = rows.length > items.length;
    const cursor = more ? items[items.length - 1]!.id : String(Math.max(latest, floor));
    return { items, cursor, more };
  }

  async prune(): Promise<number> {
    const rows = (await this.col.all()).sort((a, b) => Number(b.id) - Number(a.id));
    const cutoff = this.clock().getTime() - this.retentionDays * 24 * 3_600_000;
    let removed = 0;
    for (const [i, a] of rows.entries()) {
      if (i >= this.maxRows || Date.parse(a.at) < cutoff) {
        await this.col.delete(a.id);
        removed++;
      }
    }
    return removed;
  }
}
