import { z } from "zod";
import type { KV } from "../kv";

/**
 * Conversation history for /api/ask, stored as one JSON blob per conversation with a TTL
 * that slides on every turn. Only user text and final assistant replies are kept (not the
 * intermediate tool calls), which keeps history compact and always API-valid.
 */
export const TurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  at: z.string(),
});
export type Turn = z.infer<typeof TurnSchema>;

const HistorySchema = z.array(TurnSchema);

export class ConversationsRepo {
  constructor(
    private readonly kv: KV,
    private readonly prefix: string,
    private readonly ttlSeconds: number,
    private readonly maxTurns: number,
  ) {}

  private key(id: string) {
    return `${this.prefix}:conv:${id}`;
  }

  async load(id: string): Promise<Turn[]> {
    const raw = await this.kv.get(this.key(id));
    if (!raw) return [];
    try {
      const parsed = HistorySchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  async append(id: string, turns: Turn[]): Promise<Turn[]> {
    let history = [...(await this.load(id)), ...turns];
    if (history.length > this.maxTurns) history = history.slice(-this.maxTurns);
    // History must start with a user turn for the Messages API.
    while (history.length && history[0]?.role !== "user") history.shift();
    await this.kv.set(this.key(id), JSON.stringify(history), { exSeconds: this.ttlSeconds });
    return history;
  }
}
