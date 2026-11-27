import { config } from "../env";

/**
 * Platform key module (docs/WEBAPP.md §3.1, slice A1).
 *
 * The ONLY module that reads `config.redisPrefix()` (test/tenant-deps.test.ts enforces this).
 * Everything else gets its prefix from a tenant (`TenantDeps.tenant.prefix`) or builds a
 * platform key here with `globalKey()`.
 *
 *   `${REDIS_PREFIX}`              legacy owner prefix (the owner tenant until its data is moved, §3.2)
 *   `${REDIS_PREFIX}:t:<tenantId>` every other tenant's prefix
 *   `${REDIS_PREFIX}:g:...`        platform keys (no customer data; how a tenant is found)
 *
 * Because the owner's legacy keys sit directly under `${REDIS_PREFIX}:`, the names `t` and `g`
 * are reserved there: no repo or key builder may use them as its first key segment.
 */

/** First key segments that must never be used under a tenant prefix (they'd collide with `t:`/`g:`). */
export const RESERVED_SEGMENTS: readonly string[] = ["t", "g"];

/** `t_` + 26 lowercase base32 chars (130 random bits). Never derived from an email or Google id. */
export const TENANT_ID_RE = /^t_[a-z2-7]{26}$/;

export function isTenantId(id: unknown): id is string {
  return typeof id === "string" && TENANT_ID_RE.test(id);
}

/** The root every key lives under (`REDIS_PREFIX`, default `sk`). */
export function platformRoot(): string {
  return config.redisPrefix();
}

/** The owner tenant's legacy prefix: the bare root, where the owner's data already lives. */
export function legacyOwnerPrefix(): string {
  return platformRoot();
}

/** The prefix for a tenant created under accounts: `${root}:t:<tenantId>`. */
export function tenantPrefixFor(tenantId: string): string {
  if (!isTenantId(tenantId)) throw new Error("invalid tenant id");
  return `${platformRoot()}:t:${tenantId}`;
}

/** True when `prefix` is a valid prefix for this tenant: its own `t:` prefix, or the legacy root for the owner. */
export function isAllowedTenantPrefix(prefix: string, tenantId: string, role: "owner" | "customer"): boolean {
  if (!isTenantId(tenantId)) return false;
  if (prefix === tenantPrefixFor(tenantId)) return true;
  return role === "owner" && prefix === legacyOwnerPrefix();
}

const SEGMENT_RE = /^[A-Za-z0-9_.@-]+$/;

/** A platform key: `${root}:g:<part>:<part>…`. Parts are plain segments (no `:`, no spaces). */
export function globalKey(...parts: string[]): string {
  if (parts.length === 0) throw new Error("globalKey needs at least one part");
  for (const p of parts) if (!SEGMENT_RE.test(p)) throw new Error("invalid key segment");
  return `${platformRoot()}:g:${parts.join(":")}`;
}
