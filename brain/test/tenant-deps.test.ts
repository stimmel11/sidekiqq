import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDeps, buildPlatformDeps, legacyOwnerScope, setDeps, tenantDeps } from "@/lib/deps";
import { globalKey, isAllowedTenantPrefix, isTenantId, legacyOwnerPrefix, RESERVED_SEGMENTS, tenantPrefixFor } from "@/lib/platform/keys";
import { newTenantId, TenantRegistry } from "@/lib/platform/tenants";
import { Collection } from "@/lib/repos/collection";
import { GET as scan } from "@/app/api/cron/scan/route";
import { makeDeps, MemoryKV, req } from "./fakes";

/**
 * Accounts slice A1 (docs/WEBAPP.md §3.1–3.2, §10): PlatformDeps/TenantDeps split, the owner
 * tenant record on the legacy prefix, and the static prefix test. No behaviour change.
 */

const SRC = path.resolve(__dirname, "../src");
const KEYS_MODULE = path.join(SRC, "lib/platform/keys.ts");
const ENV_MODULE = path.join(SRC, "lib/env.ts");
/**
 * Temporary: the dashboard device bridge keeps its `dashboard:device-token` key until the bridge
 * is removed (docs/WEBAPP.md §3.1, §4.2). Delete this entry with the bridge. No other exceptions.
 */
const TEMPORARY_EXCEPTIONS = [path.join(SRC, "lib/dashboard/device-bridge.ts")];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");

describe("static prefix rules", () => {
  const files = walk(SRC);
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TOKEN_KEY;
  });
  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("only the platform key module reads REDIS_PREFIX", () => {
    const offenders = files.filter((f) => {
      if (f === KEYS_MODULE || f === ENV_MODULE || TEMPORARY_EXCEPTIONS.includes(f)) return false;
      const c = code(f);
      return /\bredisPrefix\b/.test(c) || /\bREDIS_PREFIX\b/.test(c);
    });
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("env.ts defines redisPrefix and the keys module is its only caller besides the listed exception", () => {
    expect(code(ENV_MODULE)).toMatch(/redisPrefix\s*:/);
    expect(code(KEYS_MODULE)).toMatch(/config\.redisPrefix\(\)/);
    for (const f of TEMPORARY_EXCEPTIONS) {
      // When the bridge goes, its exception must go too (this fails if the file no longer exists).
      expect(() => statSync(f)).not.toThrow();
    }
  });

  it("no key builder uses a reserved first segment (t, g) under a prefix", () => {
    // `${prefix}:t:…` / `${this.prefix}:g` would collide with tenant and platform keys under the legacy owner prefix.
    const tmpl = /\$\{[^}]*\}:(t|g)(?=[:`$])/;
    // new Collection(kv, prefix, "t", …) / "g"
    const coll = /new\s+Collection\s*\(\s*[^,]+,\s*[^,]+,\s*["'`](t|g)["'`]/;
    // "sk" + ":g:", [prefix, "t"].join(":")
    const concat = /["'`]:(t|g):|,\s*["'`](t|g)["'`]\s*\]\s*\.join/;
    const offenders = files.filter((f) => f !== KEYS_MODULE && [tmpl, coll, concat].some((r) => r.test(code(f))));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("every repo collection key under the legacy prefix stays clear of sk:t: and sk:g:", () => {
    const deps = buildDeps(new MemoryKV());
    const keys: string[] = [];
    for (const repo of Object.values(deps.repos)) {
      for (const v of Object.values(repo as unknown as Record<string, unknown>)) if (v instanceof Collection) keys.push(v.key);
    }
    expect(keys.length).toBeGreaterThanOrEqual(10);
    for (const k of keys) {
      expect(k.startsWith("sk:")).toBe(true);
      const first = k.slice("sk:".length).split(":")[0]!;
      expect(RESERVED_SEGMENTS).not.toContain(first);
    }
  });

  it("writes through the stores (repos, connections, Web Push, locks) stay clear of sk:t: and sk:g:", async () => {
    const kv = new MemoryKV();
    const deps = buildDeps(kv);
    await deps.repos.drafts.create({ to: ["a@example.com"], subject: "s", body: "b", reason: "r" } as never);
    await deps.repos.state.setTop5({ items: [], updatedAt: "2026-11-21T10:00:00Z" });
    await deps.repos.state.setLastScan({ at: "2026-11-21T10:00:00Z" });
    await deps.repos.state.markMessageProcessed("m1");
    await deps.repos.state.claimAlert("a1");
    await deps.repos.drafts.acquireSendLock("d1");
    await deps.connections.save("google", { secret: "1//r", secretKind: "refresh_token", grantedScopes: [], connectedAt: "2026-10-01T00:00:00.000Z" });
    const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url");
    await deps.webPushSubs.set("dev_1", { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh, auth: Buffer.alloc(16, 2).toString("base64url") } });
    await deps.repos.devices.create("watch");
    await deps.repos.pairing.issue(600);
    await deps.repos.pairing.recordAttempt("1.2.3.4");
    expect(kv.keys().length).toBeGreaterThanOrEqual(10);
    for (const k of kv.keys()) {
      expect(k.startsWith("sk:")).toBe(true);
      expect(k.startsWith("sk:t:") || k.startsWith("sk:g:")).toBe(false);
    }
  });
});

describe("platform keys", () => {
  afterEach(() => {
    delete process.env.REDIS_PREFIX;
  });

  it("builds global and tenant keys from REDIS_PREFIX", () => {
    expect(globalKey("tenant", "t_aaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe("sk:g:tenant:t_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(tenantPrefixFor("t_aaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe("sk:t:t_aaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(legacyOwnerPrefix()).toBe("sk");
    process.env.REDIS_PREFIX = "stage";
    expect(globalKey("owner")).toBe("stage:g:owner");
    expect(legacyOwnerPrefix()).toBe("stage");
  });

  it("rejects segments that could forge another key", () => {
    for (const bad of ["", "a:b", "a b", "*", "a\nb", "../x"]) expect(() => globalKey("tenant", bad)).toThrow();
    expect(() => globalKey()).toThrow();
    for (const bad of ["t_short", "T_AAAAAAAAAAAAAAAAAAAAAAAAAA", "t_aaaaaaaaaaaaaaaaaaaaaaaaa1", "x_aaaaaaaaaaaaaaaaaaaaaaaaaa", "t_aaaaaaaaaaaaaaaaaaaaaaaaaa:x"]) {
      expect(isTenantId(bad)).toBe(false);
      expect(() => tenantPrefixFor(bad)).toThrow();
    }
  });

  it("allows the legacy prefix only for the owner role", () => {
    const id = "t_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(isAllowedTenantPrefix("sk", id, "owner")).toBe(true);
    expect(isAllowedTenantPrefix("sk", id, "customer")).toBe(false);
    expect(isAllowedTenantPrefix(`sk:t:${id}`, id, "customer")).toBe(true);
    expect(isAllowedTenantPrefix(`sk:t:${id}`, id, "owner")).toBe(true);
    expect(isAllowedTenantPrefix("sk:t:t_cccccccccccccccccccccccccc", id, "customer")).toBe(false);
    expect(isAllowedTenantPrefix("sk:g", id, "owner")).toBe(false);
  });
});

describe("tenant ids", () => {
  it("are t_ + 26 base32 chars and never repeat", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newTenantId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(isTenantId(id)).toBe(true);
  });

  it("encodes the random bytes (all-zero and all-one inputs)", () => {
    expect(newTenantId(() => new Uint8Array(17))).toBe(`t_${"a".repeat(26)}`);
    expect(newTenantId(() => new Uint8Array(17).fill(255))).toBe(`t_${"7".repeat(26)}`);
    expect(() => newTenantId(() => new Uint8Array(4))).toThrow();
  });
});

describe("TenantRegistry", () => {
  const now = new Date("2026-11-21T10:00:00Z");

  it("creates the owner tenant once, on the legacy prefix, touching only g: keys", async () => {
    const kv = new MemoryKV();
    const reg = new TenantRegistry(kv, () => now);
    expect(await reg.ownerTenantId()).toBeNull();
    const a = await reg.ensureOwnerTenant();
    expect(a).toMatchObject({ prefix: "sk", role: "owner", status: "active", plan: "owner", createdAt: now.toISOString() });
    expect(isTenantId(a.id)).toBe(true);
    const b = await reg.ensureOwnerTenant();
    expect(b).toEqual(a);
    expect(await reg.ownerTenantId()).toBe(a.id);
    expect(await reg.get(a.id)).toEqual(a);
    expect(JSON.parse((await kv.hget("sk:g:tenants", a.id))!)).toEqual({ prefix: "sk" });
    expect(kv.keys().sort()).toEqual(["sk:g:owner", `sk:g:tenant:${a.id}`, "sk:g:tenants"].sort());
  });

  it("converges under concurrent first calls", async () => {
    const kv = new MemoryKV();
    const regs = Array.from({ length: 5 }, () => new TenantRegistry(kv, () => now));
    const out = await Promise.all(regs.map((r) => r.ensureOwnerTenant()));
    expect(new Set(out.map((t) => t.id)).size).toBe(1);
    expect(Object.keys(await kv.hgetall("sk:g:tenants"))).toEqual([out[0]!.id]);
  });

  it("never overwrites an unreadable owner record", async () => {
    const kv = new MemoryKV();
    const reg = new TenantRegistry(kv, () => now);
    const { id } = await reg.ensureOwnerTenant();
    const key = `sk:g:tenant:${id}`;
    await kv.set(key, "{not json");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(reg.ensureOwnerTenant()).rejects.toThrow(/unreadable/);
    expect(await kv.get(key)).toBe("{not json");
    err.mockRestore();
  });

  it("rejects records whose prefix or id doesn't match, so a customer can't point at the owner's data", async () => {
    const kv = new MemoryKV();
    const reg = new TenantRegistry(kv, () => now);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = await reg.createCustomerTenant();
    expect(c.prefix).toBe(`sk:t:${c.id}`);
    expect(c.role).toBe("customer");
    await kv.set(`sk:g:tenant:${c.id}`, JSON.stringify({ ...c, prefix: "sk" }));
    expect(await reg.get(c.id)).toBeNull();
    const other = "t_dddddddddddddddddddddddddd";
    await kv.set(`sk:g:tenant:${other}`, JSON.stringify({ ...c, prefix: `sk:t:${other}` }));
    expect(await reg.get(other)).toBeNull(); // record's own id differs from its key
    expect(await reg.get("not-an-id")).toBeNull();
    err.mockRestore();
  });

  it("a forged record can't claim the owner role or the legacy prefix", async () => {
    const kv = new MemoryKV();
    const reg = new TenantRegistry(kv, () => now);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const owner = await reg.ensureOwnerTenant();
    const x = "t_gggggggggggggggggggggggggg";
    await kv.set(`sk:g:tenant:${x}`, JSON.stringify({ ...owner, id: x }));
    expect(await reg.get(x)).toBeNull();
    await kv.set(`sk:g:tenant:${x}`, JSON.stringify({ ...owner, id: x, prefix: `sk:t:${x}` })); // owner role, own prefix
    expect(await reg.get(x)).toBeNull();
    expect(await reg.get(owner.id)).toEqual(owner);
    // before any owner exists, nothing may claim the legacy prefix
    const kv2 = new MemoryKV();
    await kv2.set(`sk:g:tenant:${x}`, JSON.stringify({ ...owner, id: x }));
    expect(await new TenantRegistry(kv2, () => now).get(x)).toBeNull();
    err.mockRestore();
  });

  it("keeps a stored dek through a read", async () => {
    const kv = new MemoryKV();
    const reg = new TenantRegistry(kv, () => now);
    const c = await reg.createCustomerTenant();
    await kv.set(`sk:g:tenant:${c.id}`, JSON.stringify({ ...c, dek: "wrapped" }));
    expect((await reg.get(c.id))?.dek).toBe("wrapped");
  });

  it("refuses to treat a customer record as the owner", async () => {
    const kv = new MemoryKV();
    const reg = new TenantRegistry(kv, () => now);
    const c = await reg.createCustomerTenant();
    await kv.set("sk:g:owner", c.id);
    await expect(reg.ensureOwnerTenant()).rejects.toThrow(/wrong role/);
  });

  it("retries customer ids that collide and gives up after three", async () => {
    const kv = new MemoryKV();
    const fixed = "t_eeeeeeeeeeeeeeeeeeeeeeeeee";
    const ids = [fixed, fixed, "t_ffffffffffffffffffffffffff"];
    const first = await new TenantRegistry(kv, () => now, () => fixed).createCustomerTenant();
    expect(first.id).toBe(fixed);
    const reg = new TenantRegistry(kv, () => now, () => ids.shift()!);
    expect((await reg.createCustomerTenant("pro")).id).toBe("t_ffffffffffffffffffffffffff");
    await expect(new TenantRegistry(kv, () => now, () => fixed).createCustomerTenant()).rejects.toThrow(/allocate/);
  });
});

describe("PlatformDeps / TenantDeps", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TOKEN_KEY;
  });
  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("buildDeps is the legacy owner scope: same keys as before the split", async () => {
    const kv = new MemoryKV();
    const deps = buildDeps(kv);
    expect(deps.tenant).toEqual({ id: null, prefix: "sk" });
    expect(legacyOwnerScope()).toEqual({ id: null, prefix: "sk" });
    await deps.repos.drafts.create({ to: ["a@example.com"], subject: "s", body: "b", reason: "r" } as never);
    expect(kv.keys()).toEqual(["sk:drafts"]);
  });

  it("a tenant's deps write only under that tenant's prefix", async () => {
    const kv = new MemoryKV();
    const platform = buildPlatformDeps(kv);
    const tenant = await platform.tenants.createCustomerTenant();
    const before = new Set(kv.keys());
    const t = tenantDeps(platform, { id: tenant.id, prefix: tenant.prefix });
    expect(t.tenant).toEqual({ id: tenant.id, prefix: tenant.prefix });
    await t.repos.drafts.create({ to: ["a@example.com"], subject: "s", body: "b", reason: "r" } as never);
    await t.repos.state.setTop5({ items: [], updatedAt: "2026-11-21T10:00:00Z" });
    const added = kv.keys().filter((k) => !before.has(k));
    expect(added.length).toBeGreaterThan(0);
    for (const k of added) expect(k.startsWith(`${tenant.prefix}:`)).toBe(true);
    // and the owner's legacy deps can't see it
    expect(await buildDeps(kv).repos.drafts.listPending()).toEqual([]);
    expect((await t.repos.drafts.listPending()).length).toBe(1);
  });

  it("requires a prefix", () => {
    expect(() => tenantDeps(buildPlatformDeps(new MemoryKV()), { id: null, prefix: "" })).toThrow();
  });
});

describe("scan lock is per tenant", () => {
  it("uses the tenant prefix (sk:lock:scan for the owner, unchanged)", async () => {
    expect(`${buildDeps(new MemoryKV()).tenant.prefix}:lock:scan`).toBe("sk:lock:scan");
    const deps = makeDeps();
    setDeps(deps);
    await deps.kv.set(`${deps.tenant.prefix}:lock:scan`, "1", { nx: true, exSeconds: 280 });
    const res = await scan(req("GET", "/api/cron/scan", { token: "test-cron-secret" }));
    expect(await res.json()).toEqual({ ok: true, skipped: "scan already running" });
  });
});

// ----------------------------------------------------------------------------- login (cookies mocked)

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)! } : undefined),
    set: (n: string, value: string) => jar.set(n, value),
    delete: (n: string) => jar.delete(n),
  }),
  headers: async () => new Headers(),
}));

describe("owner login", () => {
  beforeEach(() => {
    jar.clear();
    process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
  });
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("counts attempts under g:rl:login and ensures the owner tenant on success", async () => {
    const { loginWithOwnerSecret } = await import("@/lib/dashboard/owner");
    const deps = makeDeps();
    expect(await loginWithOwnerSecret(deps, "wrong-wrong-wrong-wrong", "1.2.3.4")).toMatchObject({ ok: false });
    expect(await deps.tenants.ownerTenantId()).toBeNull();
    const rl = deps.kv.keys().filter((k) => k.includes(":rl:login:"));
    expect(rl).toHaveLength(1);
    expect(rl[0]).toMatch(/^sk:g:rl:login:[0-9a-f]{64}$/);
    expect(deps.kv.keys().some((k) => k.includes("dashlogin"))).toBe(false);
    expect(await loginWithOwnerSecret(deps, process.env.OWNER_SECRET!, "1.2.3.4")).toEqual({ ok: true });
    const id = await deps.tenants.ownerTenantId();
    expect(id && (await deps.tenants.get(id))).toMatchObject({ role: "owner", prefix: "sk" });
  });

  it("still signs in when the owner tenant record can't be written", async () => {
    const { loginWithOwnerSecret } = await import("@/lib/dashboard/owner");
    const deps = makeDeps();
    vi.spyOn(deps.tenants, "ensureOwnerTenant").mockRejectedValue(new Error("kv down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loginWithOwnerSecret(deps, process.env.OWNER_SECRET!, "5.6.7.8")).toEqual({ ok: true });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
