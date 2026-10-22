import { randomInt } from "node:crypto";
import type { KV } from "../kv";
import { sha256 } from "../crypto";

/** One-time 6-digit pairing codes, stored hashed with a TTL and consumed atomically (GETDEL). */
export class PairingRepo {
  constructor(private readonly kv: KV, private readonly prefix: string) {}

  private key(code: string) {
    return `${this.prefix}:pair:${sha256(code)}`;
  }

  async issue(ttlSeconds: number, label?: string): Promise<{ code: string; expiresAt: string }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
      const ok = await this.kv.set(this.key(code), JSON.stringify({ label: label ?? null }), { nx: true, exSeconds: ttlSeconds });
      if (ok) return { code, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
    }
    throw new Error("Could not allocate a unique pairing code");
  }

  /** Returns the stored label (or null) if the code was valid; the code is destroyed either way. */
  async consume(code: string): Promise<{ label: string | null } | null> {
    if (!/^\d{6}$/.test(code)) return null;
    const raw = await this.kv.getdel(this.key(code));
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { label?: string | null };
      return { label: v.label ?? null };
    } catch {
      return { label: null };
    }
  }

  /** Brute-force guard: returns the attempt count in the current window. */
  async recordAttempt(ip: string, windowSeconds = 15 * 60): Promise<number> {
    return this.kv.incrWithTtl(`${this.prefix}:pairattempts:${sha256(ip)}`, windowSeconds);
  }
}
