import { z } from "zod";
import type { KV } from "../kv";
import { Collection } from "./collection";

/**
 * Connector audit log (docs/CONNECTORS.md §4 step 4): one row per capability call, written by
 * invokeCapability. Never stores a token or a full email body. Arguments are stored only for
 * non-first-party connectors, already truncated by the caller. Bounded like the alert log.
 */
export const AuditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  connector: z.string(),
  capability: z.string(),
  tier: z.string(),
  caller: z.string(),
  device: z.string().optional(),
  summary: z.string().max(300),
  args: z.string().max(1000).optional(),
  ok: z.boolean(),
  error: z.string().max(300).optional(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type NewAuditEntry = Omit<AuditEntry, "id" | "at">;

export class AuditRepo {
  private readonly col: Collection<AuditEntry>;
  private readonly seqKey: string;

  constructor(
    private readonly kv: KV,
    prefix: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly retentionDays = 30,
    private readonly maxRows = 5000, // cron writes one row per scanned message
  ) {
    this.col = new Collection(kv, prefix, "audit", AuditEntrySchema);
    this.seqKey = `${prefix}:audit:seq`;
  }

  async add(entry: NewAuditEntry): Promise<AuditEntry> {
    const seq = await this.kv.incrWithTtl(this.seqKey, 60 * 60 * 24 * 3650);
    const row = await this.col.put({ ...entry, id: String(seq), at: this.clock().toISOString() });
    if (seq % 50 === 0) await this.prune().catch(() => undefined);
    return row;
  }

  /** Newest first. */
  async recent(limit = 100): Promise<AuditEntry[]> {
    return (await this.col.all()).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, limit);
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
