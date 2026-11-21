import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { KV } from "../kv";
import { globalKey, isAllowedTenantPrefix, isTenantId, legacyOwnerPrefix, tenantPrefixFor } from "./keys";

/**
 * Tenant records (docs/WEBAPP.md §3.1–3.2, slice A1).
 *
 *   g:owner              → owner tenantId (set once, NX)
 *   g:tenant:<tenantId>  → TenantRecord JSON
 *   g:tenants            → hash tenantId → { prefix } (cron fan-out index, §3.8; A5 adds googleConnected)
 *
 * The owner tenant is created with the legacy prefix (`REDIS_PREFIX`, e.g. `sk`) so nothing is
 * copied and every existing key keeps working. Customer tenants always get `${root}:t:<id>`.
 * A record whose prefix isn't allowed for its id/role, or that claims the owner role or the
 * legacy prefix without being the tenant named by `g:owner`, is treated as corrupt and never used.
 * The prefix is stored absolute, so changing REDIS_PREFIX makes the old record unreadable on
 * purpose (ensureOwnerTenant then throws; owner sign-in logs it and carries on).
 */

export const TenantRecordSchema = z.object({
  id: z.string().refine(isTenantId, "invalid tenant id"),
  prefix: z.string().min(1),
  createdAt: z.string(),
  status: z.enum(["active", "deleting"]),
  role: z.enum(["owner", "customer"]),
  plan: z.string().min(1),
  /** Wrapped tenant data key (A4, §3.5). Declared now so a read-then-write never strips it. */
  dek: z.string().min(1).optional(),
});
export type TenantRecord = z.infer<typeof TenantRecordSchema>;

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** `t_` + 26 base32 chars from 17 random bytes (130 bits used). */
export function newTenantId(rand: (n: number) => Uint8Array = randomBytes): string {
  const bytes = rand(17);
  if (bytes.length < 17) throw new Error("not enough random bytes");
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return `t_${out}`;
}

function parseRecord(raw: string | null, expectedId: string): TenantRecord | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    console.error("[tenants] corrupt tenant record");
    return null;
  }
  const parsed = TenantRecordSchema.safeParse(json);
  if (!parsed.success) {
    console.error("[tenants] invalid tenant record");
    return null;
  }
  const rec = parsed.data;
  if (rec.id !== expectedId || !isAllowedTenantPrefix(rec.prefix, rec.id, rec.role)) {
    console.error("[tenants] tenant record failed its prefix check");
    return null;
  }
  return rec;
}

export class TenantRegistry {
  constructor(
    private readonly kv: KV,
    private readonly clock: () => Date = () => new Date(),
    private readonly idGen: () => string = () => newTenantId(),
  ) {}

  /** Reads and validates a tenant record. Returns null for unknown, corrupt or mis-prefixed records. */
  async get(tenantId: string): Promise<TenantRecord | null> {
    if (!isTenantId(tenantId)) return null;
    const rec = parseRecord(await this.kv.get(globalKey("tenant", tenantId)), tenantId);
    if (!rec) return null;
    // A record can't vouch for itself: only the tenant named by g:owner may be the owner or use
    // the legacy prefix (where the owner's data lives).
    if (rec.role === "owner" || rec.prefix === legacyOwnerPrefix()) {
      if (rec.id !== (await this.ownerTenantId())) {
        console.error("[tenants] owner-only record for a tenant that isn't the owner");
        return null;
      }
    }
    return rec;
  }

  /** The owner tenant's id, if the record has been created. */
  async ownerTenantId(): Promise<string | null> {
    const id = await this.kv.get(globalKey("owner"));
    return isTenantId(id) ? id : null;
  }

  /**
   * Idempotently creates the owner tenant (role `owner`, legacy prefix) and returns it.
   * Safe under concurrent calls: the id is claimed with SET NX and the record with SET NX,
   * so every caller ends up with the same record.
   */
  async ensureOwnerTenant(): Promise<TenantRecord> {
    const ownerKey = globalKey("owner");
    let id = await this.kv.get(ownerKey);
    if (id === null) {
      const candidate = this.idGen();
      if (!isTenantId(candidate)) throw new Error("tenant id generator returned an invalid id");
      await this.kv.set(ownerKey, candidate, { nx: true });
      id = await this.kv.get(ownerKey);
    }
    if (!isTenantId(id)) throw new Error("owner tenant id is corrupt");
    const existing = await this.get(id);
    if (existing) {
      if (existing.role !== "owner") throw new Error("owner tenant record has the wrong role");
      return existing;
    }
    const record: TenantRecord = {
      id,
      prefix: legacyOwnerPrefix(),
      createdAt: this.clock().toISOString(),
      status: "active",
      role: "owner",
      plan: "owner",
    };
    const recordKey = globalKey("tenant", id);
    if (!(await this.kv.set(recordKey, JSON.stringify(record), { nx: true }))) {
      // Another caller wrote it first (or it exists but failed validation: never overwrite that).
      const raced = await this.get(id);
      if (!raced || raced.role !== "owner") throw new Error("owner tenant record is unreadable");
      await this.index(raced);
      return raced;
    }
    await this.index(record);
    return record;
  }

  /**
   * Creates a customer tenant with its own `${root}:t:<id>` prefix. Not reachable from any route
   * yet: sign-up (A3) will call it.
   */
  async createCustomerTenant(plan = "free"): Promise<TenantRecord> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = this.idGen();
      if (!isTenantId(id)) throw new Error("tenant id generator returned an invalid id");
      const record: TenantRecord = {
        id,
        prefix: tenantPrefixFor(id),
        createdAt: this.clock().toISOString(),
        status: "active",
        role: "customer",
        plan,
      };
      if (await this.kv.set(globalKey("tenant", id), JSON.stringify(record), { nx: true })) {
        await this.index(record);
        return record;
      }
    }
    throw new Error("could not allocate a tenant id");
  }

  private async index(record: TenantRecord): Promise<void> {
    await this.kv.hset(globalKey("tenants"), record.id, JSON.stringify({ prefix: record.prefix }));
  }
}
