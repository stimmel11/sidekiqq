import type { KV } from "../kv";
import { DraftSchema, type Draft } from "../models";
import { newId } from "../util";
import { Collection } from "./collection";

export type NewDraft = Omit<Draft, "id" | "status" | "createdAt" | "cc"> & { cc?: string[] };

export class DraftsRepo {
  private readonly col: Collection<Draft>;
  constructor(
    private readonly kv: KV,
    private readonly prefix: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.col = new Collection(kv, prefix, "drafts", DraftSchema);
  }

  async create(input: NewDraft): Promise<Draft> {
    return this.col.put({
      ...input,
      cc: input.cc ?? [],
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

  async markSent(id: string, gmailMessageId: string | undefined): Promise<Draft | null> {
    const cur = await this.col.get(id);
    if (!cur) return null;
    return this.col.put({
      ...cur,
      status: "sent",
      sentAt: this.clock().toISOString(),
      ...(gmailMessageId ? { gmailMessageId } : {}),
    });
  }

  async markDiscarded(id: string): Promise<Draft | null> {
    const cur = await this.col.get(id);
    if (!cur) return null;
    return this.col.put({ ...cur, status: "discarded" });
  }
}
