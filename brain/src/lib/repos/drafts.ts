import { buildReadback } from "../connectors/readback";
import { config } from "../env";
import type { KV } from "../kv";
import { DraftSchema, type Draft } from "../models";
import { newId } from "../util";
import { Collection } from "./collection";

/**
 * What a caller supplies to create a draft. `readback` is deliberately absent: the repo builds it
 * from the structured fields (docs/CONNECTORS.md §5), so no caller (and no model) can write it.
 */
export type NewDraft = Omit<Draft, "id" | "status" | "createdAt" | "cc" | "kind" | "connectorId" | "readback" | "sentAt" | "providerMessageId"> & {
  cc?: string[];
  kind?: Draft["kind"];
  connectorId?: string;
};

export class DraftsRepo {
  private readonly col: Collection<Draft>;
  constructor(
    private readonly kv: KV,
    private readonly prefix: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly timeZone: () => string = config.ownerTimezone,
  ) {
    this.col = new Collection(kv, prefix, "drafts", DraftSchema);
  }

  async create(input: NewDraft): Promise<Draft> {
    const kind = input.kind ?? "email";
    const cc = input.cc ?? [];
    const { readback: _ignored, ...fields } = input as NewDraft & { readback?: unknown };
    return this.col.put({
      ...fields,
      kind,
      connectorId: input.connectorId ?? "google",
      cc,
      readback: buildReadback({ kind, to: input.to, cc, subject: input.subject, ...(input.when ? { when: input.when } : {}) }, this.timeZone()),
      id: newId("drf"),
      status: "pending",
      createdAt: this.clock().toISOString(),
    });
  }

  get(id: string) {
    return this.col.get(id);
  }

  async listPending(): Promise<Draft[]> {
    return (await this.col.all()).filter((d) => d.status === "pending");
  }

  /**
   * Short-lived lock so a double-tap "Approve" on a watch can't send twice.
   * Returns true if this caller owns the lock.
   */
  async acquireSendLock(id: string, ttlSeconds = 60): Promise<boolean> {
    return this.kv.set(`${this.prefix}:lock:draft-send:${id}`, "1", { nx: true, exSeconds: ttlSeconds });
  }

  async releaseSendLock(id: string): Promise<void> {
    await this.kv.del(`${this.prefix}:lock:draft-send:${id}`);
  }

  async markSent(id: string, providerMessageId: string | undefined): Promise<Draft | null> {
    const cur = await this.col.get(id);
    if (!cur) return null;
    return this.col.put({
      ...cur,
      status: "sent",
      sentAt: this.clock().toISOString(),
      ...(providerMessageId ? { providerMessageId } : {}),
    });
  }

  async markDiscarded(id: string): Promise<Draft | null> {
    const cur = await this.col.get(id);
    if (!cur) return null;
    return this.col.put({ ...cur, status: "discarded" });
  }
}
