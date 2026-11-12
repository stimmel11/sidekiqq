import type { KV } from "../kv";
import { SEARCHED_TTL_MS, type SearchedProducts } from "./grocery";
import { KROGER_PRODUCT_ID_RE } from "./rules";

/**
 * KV-backed `SearchedProducts` (backlog "Connector: Kroger" slice 2a), so a product id returned by
 * `grocery.search` in one serverless invocation is addable from another (search and add usually
 * run in the same `/api/ask` request, but a follow-up "add two of those" is a new request).
 *
 * One hash, `<prefix>:kroger:searched`: field = 13-digit product id, value = expiry (ms since the
 * epoch). `missing` is one HGETALL for the whole cart. `remember` prunes expired fields and, past
 * `maxIds`, the soonest-to-expire ones, so the hash stays bounded. Only well-formed product ids are
 * stored; anything else is never addable anyway (`parseCartLines`).
 */
export const SEARCHED_MAX_IDS = 1000;

export class KvSearchedProducts implements SearchedProducts {
  constructor(
    private readonly kv: KV,
    private readonly prefix: string,
    private readonly ttlMs = SEARCHED_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly maxIds = SEARCHED_MAX_IDS,
  ) {}

  private key(): string {
    return `${this.prefix}:kroger:searched`;
  }

  /** Live entries only; unparseable values count as expired. */
  private async live(): Promise<{ all: Record<string, string>; live: Map<string, number> }> {
    const all = await this.kv.hgetall(this.key());
    const now = this.now();
    const live = new Map<string, number>();
    for (const [id, raw] of Object.entries(all)) {
      const until = Number(raw);
      if (KROGER_PRODUCT_ID_RE.test(id) && Number.isFinite(until) && until > now) live.set(id, until);
    }
    return { all, live };
  }

  async remember(ids: string[]): Promise<void> {
    const fresh = [...new Set(ids.filter((id) => typeof id === "string" && KROGER_PRODUCT_ID_RE.test(id)))];
    if (fresh.length === 0) return;
    const until = this.now() + this.ttlMs;
    await Promise.all(fresh.map((id) => this.kv.hset(this.key(), id, String(until))));
    try {
      await this.prune(new Set(fresh));
    } catch (err) {
      // Pruning is housekeeping; the ids are already remembered.
      console.warn("[kroger] pruning searched products failed", (err as Error)?.message);
    }
  }

  async missing(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const { live } = await this.live();
    return ids.filter((id) => !live.has(id));
  }

  /**
   * Drop expired/junk fields, then the soonest-expiring live ones above `maxIds` (never `keep`).
   * Not atomic: a concurrent `remember` of an id this prune saw as expired (or, over the cap, as
   * oldest) can lose that entry. That fails closed: the add is refused until the owner searches again.
   */
  private async prune(keep: Set<string>): Promise<void> {
    const { all, live } = await this.live();
    const drop = Object.keys(all).filter((id) => !live.has(id));
    const over = live.size - this.maxIds;
    if (over > 0) {
      const oldest = [...live].filter(([id]) => !keep.has(id)).sort((a, b) => a[1] - b[1]);
      drop.push(...oldest.slice(0, over).map(([id]) => id));
    }
    await Promise.all(drop.map((id) => this.kv.hdel(this.key(), id)));
  }
}
