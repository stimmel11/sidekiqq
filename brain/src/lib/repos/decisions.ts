import type { KV } from "../kv";
import { DecisionSchema, type Decision } from "../models";
import { newId, normalizeDate, sameClient } from "../util";
import { Collection } from "./collection";

export type NewDecision = Omit<Decision, "id" | "createdAt" | "decidedAt" | "people" | "confidence"> &
  Partial<Pick<Decision, "decidedAt" | "people" | "confidence">>;

export class DecisionsRepo {
  private readonly col: Collection<Decision>;
  constructor(kv: KV, prefix: string, private readonly clock: () => Date = () => new Date()) {
    this.col = new Collection(kv, prefix, "decisions", DecisionSchema);
  }

  async add(input: NewDecision): Promise<Decision> {
    const now = this.clock().toISOString();
    return this.col.put({
      ...input,
      id: newId("dec"),
      decidedAt: normalizeDate(input.decidedAt) ?? now,
      people: input.people ?? [],
      confidence: input.confidence ?? "CONFIRMED",
      createdAt: now,
    });
  }

  async list(opts: { client?: string; project?: string } = {}): Promise<Decision[]> {
    return (await this.col.all())
      .filter(
        (d) =>
          (!opts.client || sameClient(d.client, opts.client)) && (!opts.project || sameClient(d.project, opts.project)),
      )
      .sort((a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt));
  }
}
