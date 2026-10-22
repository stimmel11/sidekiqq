import type { ZodType } from "zod";
import type { KV } from "../kv";

/**
 * A typed record collection stored as one Redis hash (`<prefix>:<name>`: id -> JSON).
 * SideKiqq is single-owner, so collections stay small (hundreds to low thousands of rows)
 * and a full HGETALL + in-process filter is simpler and cheaper than secondary indexes.
 * Every read is validated; corrupt rows are skipped and logged rather than crashing a route.
 */
export class Collection<T extends { id: string }> {
  readonly key: string;

  constructor(
    private readonly kv: KV,
    prefix: string,
    name: string,
    private readonly schema: ZodType<T>,
  ) {
    this.key = `${prefix}:${name}`;
  }

  async get(id: string): Promise<T | null> {
    const raw = await this.kv.hget(this.key, id);
    return raw === null ? null : this.decode(id, raw);
  }

  async put(record: T): Promise<T> {
    const valid = this.schema.parse(record);
    await this.kv.hset(this.key, valid.id, JSON.stringify(valid));
    return valid;
  }

  async all(): Promise<T[]> {
    const rows = await this.kv.hgetall(this.key);
    const out: T[] = [];
    for (const [id, raw] of Object.entries(rows)) {
      const rec = this.decode(id, raw);
      if (rec) out.push(rec);
    }
    return out;
  }

  async delete(id: string): Promise<boolean> {
    return (await this.kv.hdel(this.key, id)) > 0;
  }

  private decode(id: string, raw: string): T | null {
    try {
      const parsed = this.schema.safeParse(typeof raw === "string" ? JSON.parse(raw) : raw);
      if (parsed.success) return parsed.data;
      console.warn(`[repo] invalid row ${this.key}/${id}: ${parsed.error.message}`);
    } catch {
      console.warn(`[repo] unparseable row ${this.key}/${id}`);
    }
    return null;
  }
}
