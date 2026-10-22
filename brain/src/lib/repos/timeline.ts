import type { KV } from "../kv";
import { TimelineEventSchema, type TimelineEvent } from "../models";
import { newId, normalizeDate, sameClient } from "../util";
import { Collection } from "./collection";

export type NewTimelineEvent = Omit<TimelineEvent, "id" | "at" | "people" | "categories" | "importance"> &
  Partial<Pick<TimelineEvent, "at" | "people" | "categories" | "importance">>;

export class TimelineRepo {
  private readonly col: Collection<TimelineEvent>;
  constructor(kv: KV, prefix: string, private readonly clock: () => Date = () => new Date()) {
    this.col = new Collection(kv, prefix, "timeline", TimelineEventSchema);
  }

  async add(input: NewTimelineEvent): Promise<TimelineEvent> {
    return this.col.put({
      ...input,
      id: newId("evt"),
      at: normalizeDate(input.at) ?? this.clock().toISOString(),
      people: input.people ?? [],
      categories: input.categories ?? [],
      importance: input.importance ?? "LOW",
    });
  }

  /** Chronological events for one client (or project). Never mixes clients. */
  async forClient(client: string, opts: { limit?: number; project?: string } = {}): Promise<TimelineEvent[]> {
    const rows = (await this.col.all())
      .filter((e) => sameClient(e.client, client) || (opts.project !== undefined && sameClient(e.project, opts.project)))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return opts.limit ? rows.slice(-opts.limit) : rows;
  }

  async since(sinceIso: string): Promise<TimelineEvent[]> {
    const t = Date.parse(sinceIso);
    return (await this.col.all()).filter((e) => Date.parse(e.at) >= t).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }
}
