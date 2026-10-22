import type { KV } from "../kv";
import { FollowUpSchema, StoredFollowUpSchema, type FollowUp, type Importance, type StoredFollowUp } from "../models";
import { daysBetween, IMPORTANCE_RANK, newId, normalizeDate, sameClient, slugify } from "../util";
import { Collection } from "./collection";

export interface NewFollowUp {
  person: string;
  client?: string;
  reason: string;
  importance: Importance;
  suggestedMessage?: string;
  draftId?: string;
  lastContactAt?: string;
  source?: StoredFollowUp["source"];
}

export function toContract(f: StoredFollowUp, now: Date): FollowUp {
  return FollowUpSchema.parse({
    ...f,
    ...(f.lastContactAt ? { daysQuiet: daysBetween(f.lastContactAt, now) } : {}),
  });
}

export class FollowUpsRepo {
  private readonly col: Collection<StoredFollowUp>;
  constructor(kv: KV, prefix: string, private readonly clock: () => Date = () => new Date()) {
    this.col = new Collection(kv, prefix, "followups", StoredFollowUpSchema);
  }

  /** Upsert: one unresolved follow-up per (person, client); newer info refreshes it. */
  async upsert(input: NewFollowUp): Promise<{ followUp: StoredFollowUp; created: boolean }> {
    const now = this.clock().toISOString();
    const existing = (await this.col.all()).find(
      (f) => !f.resolved && slugify(f.person) === slugify(input.person) && (f.client ?? "") === (input.client ?? ""),
    );
    const lastContactAt = normalizeDate(input.lastContactAt);
    if (existing) {
      const merged: StoredFollowUp = {
        ...existing,
        reason: input.reason,
        importance: IMPORTANCE_RANK[input.importance] > IMPORTANCE_RANK[existing.importance] ? input.importance : existing.importance,
        ...(input.suggestedMessage ? { suggestedMessage: input.suggestedMessage } : {}),
        ...(input.draftId ? { draftId: input.draftId } : {}),
        ...(lastContactAt ? { lastContactAt } : {}),
        updatedAt: now,
      };
      return { followUp: await this.col.put(merged), created: false };
    }
    const rec: StoredFollowUp = {
      id: newId("fu"),
      person: input.person,
      ...(input.client ? { client: input.client } : {}),
      reason: input.reason,
      importance: input.importance,
      ...(input.suggestedMessage ? { suggestedMessage: input.suggestedMessage } : {}),
      ...(input.draftId ? { draftId: input.draftId } : {}),
      ...(lastContactAt ? { lastContactAt } : {}),
      ...(input.source ? { source: input.source } : {}),
      createdAt: now,
      updatedAt: now,
      resolved: false,
    };
    return { followUp: await this.col.put(rec), created: true };
  }

  get(id: string) {
    return this.col.get(id);
  }

  async attachDraft(id: string, draftId: string): Promise<StoredFollowUp | null> {
    const cur = await this.col.get(id);
    if (!cur) return null;
    return this.col.put({ ...cur, draftId, updatedAt: this.clock().toISOString() });
  }

  async resolve(id: string): Promise<boolean> {
    const cur = await this.col.get(id);
    if (!cur) return false;
    await this.col.put({ ...cur, resolved: true, updatedAt: this.clock().toISOString() });
    return true;
  }

  /** Unresolved follow-ups, most important then longest-quiet first. */
  async list(opts: { client?: string } = {}): Promise<FollowUp[]> {
    const now = this.clock();
    return (await this.col.all())
      .filter((f) => !f.resolved && (!opts.client || sameClient(f.client, opts.client)))
      .map((f) => toContract(f, now))
      .sort(
        (a, b) =>
          IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance] || (b.daysQuiet ?? 0) - (a.daysQuiet ?? 0),
      );
  }
}
