import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKV } from "./fakes";
import { ConnectionStore } from "@/lib/connectors/store";
import { ReauthRequiredError } from "@/lib/connectors/types";
import { KvRefreshLock, type FetchLike } from "@/lib/connectors/zoom/auth";
import {
  KROGER_OAUTH_BASE,
  KROGER_USER_SCOPES,
  KrogerAuth,
  krogerConfigFromEnv,
  KrogerNotConnectedError,
  krogerRefreshLock,
  KrogerSignInError,
} from "@/lib/connectors/kroger/auth";
import { KrogerAuthError, KrogerGrocery, krogerHttpApi, MemorySearchedProducts, SEARCHED_TTL_MS } from "@/lib/kroger/grocery";
import { KvSearchedProducts } from "@/lib/kroger/searched";

const NOW = new Date("2026-11-11T15:00:00Z");
const CFG = { clientId: "kcid", clientSecret: "ksecret", redirectUri: "https://brain.example/api/connections/kroger/callback" };
const SCOPE = KROGER_USER_SCOPES.join(" ");

const kvs = new WeakMap<ConnectionStore, MemoryKV>();
function stableStore() {
  const kv = new MemoryKV(() => NOW.getTime());
  const key = randomBytes(32);
  const s = new ConnectionStore(kv, "t", () => ({ current: key }));
  kvs.set(s, kv);
  return s;
}
const kvOf = (s: ConnectionStore) => kvs.get(s)!;

async function connect(s: ConnectionStore, secret = "rt-1", connectedAt = NOW.toISOString()) {
  await s.save("kroger", { secret, secretKind: "refresh_token", grantedScopes: [...KROGER_USER_SCOPES], connectedAt });
}

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return { fn, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const form = (c: Call) => Object.fromEntries(new URLSearchParams(String(c.init.body)));

function clearEnv() {
  delete process.env.KROGER_CLIENT_ID;
  delete process.env.KROGER_CLIENT_SECRET;
  delete process.env.KROGER_REDIRECT_URI;
}
const savedEnv = { id: process.env.KROGER_CLIENT_ID, secret: process.env.KROGER_CLIENT_SECRET, redirect: process.env.KROGER_REDIRECT_URI };
beforeEach(clearEnv);
afterEach(() => {
  clearEnv();
  if (savedEnv.id !== undefined) process.env.KROGER_CLIENT_ID = savedEnv.id;
  if (savedEnv.secret !== undefined) process.env.KROGER_CLIENT_SECRET = savedEnv.secret;
  if (savedEnv.redirect !== undefined) process.env.KROGER_REDIRECT_URI = savedEnv.redirect;
  vi.restoreAllMocks();
});

describe("KrogerAuth: owner sign-in", () => {
  it("builds a PKCE authorize URL asking only for search + add-only cart", () => {
    const u = new URL(new KrogerAuth(CFG, stableStore()).authorizeUrl({ state: "st", codeChallenge: "ch" }));
    expect(u.origin + u.pathname).toBe(`${KROGER_OAUTH_BASE}/authorize`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      client_id: "kcid",
      redirect_uri: CFG.redirectUri,
      scope: "product.compact cart.basic:write",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
    expect(u.searchParams.get("scope")).not.toMatch(/profile|order|payment|cart\.basic:read/);
  });

  it("exchanges the code with the verifier and stores the refresh token encrypted", async () => {
    const s = stableStore();
    const f = fakeFetch(() => json(200, { access_token: "at-0", refresh_token: "rt-0", expires_in: 1800, scope: SCOPE, token_type: "bearer" }));
    const a = new KrogerAuth(CFG, s, f.fn, () => NOW.getTime());
    await a.exchangeCode("code-1", "verifier-1", NOW.toISOString());
    expect(f.calls[0]!.url).toBe(`${KROGER_OAUTH_BASE}/token`);
    expect(form(f.calls[0]!)).toEqual({ grant_type: "authorization_code", code: "code-1", redirect_uri: CFG.redirectUri, code_verifier: "verifier-1" });
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("kcid:ksecret").toString("base64")}`);
    expect(f.calls[0]!.init.redirect).toBe("error");
    expect(await s.load("kroger")).toMatchObject({ secret: "rt-0", secretKind: "refresh_token", grantedScopes: [...KROGER_USER_SCOPES], status: "connected" });
    expect(await kvOf(s).get("t:conn:kroger:tokens")).not.toContain("rt-0");
    expect(await a.userToken()).toBe("at-0"); // cached
    expect(f.calls).toHaveLength(1);
  });

  it("a token response without `scope` records the requested scopes; one without a refresh token stores nothing", async () => {
    const s = stableStore();
    await new KrogerAuth(CFG, s, fakeFetch(() => json(200, { access_token: "a", refresh_token: "r", expires_in: 1800 })).fn).exchangeCode("c", "v", NOW.toISOString());
    expect((await s.load("kroger"))?.grantedScopes).toEqual([...KROGER_USER_SCOPES]);
    const s2 = stableStore();
    const noRt = new KrogerAuth(CFG, s2, fakeFetch(() => json(200, { access_token: "a", expires_in: 1800 })).fn);
    await expect(noRt.exchangeCode("c", "v", NOW.toISOString())).rejects.toBeInstanceOf(KrogerSignInError);
    expect(await s2.load("kroger")).toBeNull();
  });

  it("not connected → KrogerNotConnectedError, no network", async () => {
    const f = fakeFetch(() => json(200, {}));
    await expect(new KrogerAuth(CFG, stableStore(), f.fn).userToken()).rejects.toBeInstanceOf(KrogerNotConnectedError);
    expect(f.calls).toHaveLength(0);
  });

  it("refreshes, saves a rotated refresh token before use, and shares one refresh between callers", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    const f = fakeFetch(() => json(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 1800 }));
    const a = new KrogerAuth(CFG, s, f.fn, () => NOW.getTime());
    expect(await Promise.all([a.userToken(), a.userToken(), a.userToken()])).toEqual(["at-2", "at-2", "at-2"]);
    expect(f.calls).toHaveLength(1);
    expect(form(f.calls[0]!)).toEqual({ grant_type: "refresh_token", refresh_token: "rt-1" });
    expect((await s.load("kroger"))?.secret).toBe("rt-2");
  });

  it("keeps the stored token when Kroger doesn't rotate it, and refreshes after expiry (30 min tokens)", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    let t = NOW.getTime();
    let n = 0;
    const f = fakeFetch(() => json(200, { access_token: `at-${++n}`, expires_in: 1800 }));
    const a = new KrogerAuth(CFG, s, f.fn, () => t);
    expect(await a.userToken()).toBe("at-1");
    t += 1750_000; // 50 s left: inside the 60 s slack
    expect(await a.userToken()).toBe("at-2");
    expect((await s.load("kroger"))?.secret).toBe("rt-1");
    expect(form(f.calls[1]!).refresh_token).toBe("rt-1");
  });

  it("a reconnect invalidates the cached token; a disconnect makes it unusable", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    let n = 0;
    const f = fakeFetch(() => json(200, { access_token: `at-${++n}`, expires_in: 1800 }));
    const a = new KrogerAuth(CFG, s, f.fn, () => NOW.getTime());
    expect(await a.userToken()).toBe("at-1");
    await connect(s, "rt-new", "2026-11-11T16:00:00.000Z");
    expect(await a.userToken()).toBe("at-2");
    expect(form(f.calls[1]!).refresh_token).toBe("rt-new");
    await s.clear("kroger");
    await expect(a.userToken()).rejects.toBeInstanceOf(KrogerNotConnectedError);
  });

  it("a dead refresh token → ReauthRequiredError naming the stored secret; misconfig is not reauth and leaks nothing", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    const err = await new KrogerAuth(CFG, s, fakeFetch(() => json(400, { error: "invalid_grant", error_description: "rt-1 expired" })).fn)
      .userToken()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReauthRequiredError);
    expect((err as ReauthRequiredError).connectorId).toBe("kroger");
    expect((err as ReauthRequiredError).failedSecret).toBe("rt-1");
    expect((err as Error).message).not.toContain("rt-1");

    const mis = await new KrogerAuth(CFG, s, fakeFetch(() => json(401, { error: "invalid_client", error_description: "bad ksecret" })).fn)
      .userToken()
      .catch((e: unknown) => e);
    expect(mis).toBeInstanceOf(KrogerSignInError);
    expect(mis).not.toBeInstanceOf(ReauthRequiredError);
    expect((mis as Error).message).toBe("Kroger sign-in failed (HTTP 401, invalid_client).");

    const odd = await new KrogerAuth(CFG, s, fakeFetch(() => json(400, { error: "rt-1 <script>" })).fn).userToken().catch((e: unknown) => e);
    expect((odd as Error).message).toBe("Kroger sign-in failed (HTTP 400).");
  });

  it("network failure and a missing access token are sign-in errors, not reauth", async () => {
    const s = stableStore();
    await connect(s);
    const down: FetchLike = async () => {
      throw Object.assign(new Error("x"), { name: "TimeoutError" });
    };
    await expect(new KrogerAuth(CFG, s, down).userToken()).rejects.toThrow("Kroger sign-in timed out.");
    await expect(new KrogerAuth(CFG, s, fakeFetch(() => json(200, { refresh_token: "rt-9" })).fn).userToken()).rejects.toThrow(/no access token/);
    expect((await s.load("kroger"))?.secret).toBe("rt-1"); // nothing written from a bad response
  });

  it("retries once with a token another instance rotated in the meantime", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    const f = fakeFetch(async (_u, init, n) => {
      if (n === 1) {
        await s.update("kroger", (v) => ({ ...v, secret: "rt-2" }));
        return json(400, { error: "invalid_grant" });
      }
      expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe("rt-2");
      return json(200, { access_token: "at-3", refresh_token: "rt-3", expires_in: 1800 });
    });
    expect(await new KrogerAuth(CFG, s, f.fn).userToken()).toBe("at-3");
    expect((await s.load("kroger"))?.secret).toBe("rt-3");
  });

  it("serialises refreshes across instances with the KV lock, each using the latest token", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    const lock = new KvRefreshLock(kvOf(s), "t:conn:kroger:refresh-lock", { pollMs: 1 });
    const live = new Set(["rt-1"]);
    let n = 0;
    const f = fakeFetch(async (_u, init) => {
      const rt = new URLSearchParams(String(init.body)).get("refresh_token")!;
      await new Promise((r) => setTimeout(r, 5));
      if (!live.delete(rt)) return json(400, { error: "invalid_grant" });
      n += 1;
      live.add(`rt-${n + 1}`);
      return json(200, { access_token: `at-${n}`, refresh_token: `rt-${n + 1}`, expires_in: 1800 });
    });
    const tokens = await Promise.all([0, 1, 2].map(() => new KrogerAuth(CFG, s, f.fn, () => NOW.getTime(), lock).userToken()));
    expect(new Set(tokens).size).toBe(3);
    expect(f.calls).toHaveLength(3); // no refresh ever used an already-spent token
    expect(await s.load("kroger")).toMatchObject({ secret: "rt-4", status: "connected" });
    expect(await kvOf(s).get("t:conn:kroger:refresh-lock")).toBeNull();
    expect(krogerRefreshLock(kvOf(s), "t")).toBeInstanceOf(KvRefreshLock);
  });

  it("a valid refresh clears a needs_reauth set by a racing instance", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    await s.markNeedsReauth("kroger", "race", "rt-1");
    await new KrogerAuth(CFG, s, fakeFetch(() => json(200, { access_token: "at-1", refresh_token: "rt-2", expires_in: 1800 })).fn).userToken();
    const v = await s.load("kroger");
    expect(v).toMatchObject({ secret: "rt-2", status: "connected" });
    expect(v?.lastError).toBeUndefined();
  });

  it("keeps a rotated token in memory when every save fails, and refreshes with it next time", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const update = vi.spyOn(s, "update").mockRejectedValue(new Error("KV down"));
    let t = NOW.getTime();
    let n = 0;
    const f = fakeFetch(() => {
      n += 1;
      return json(200, { access_token: `at-${n}`, refresh_token: `rt-${n + 1}`, expires_in: 1800 });
    });
    const a = new KrogerAuth(CFG, s, f.fn, () => t, undefined, 0);
    expect(await a.userToken()).toBe("at-1");
    expect(update).toHaveBeenCalledTimes(3);
    update.mockRestore();
    t += 1800_000;
    expect(await a.userToken()).toBe("at-2");
    expect(form(f.calls[1]!).refresh_token).toBe("rt-2");
    expect((await s.load("kroger"))?.secret).toBe("rt-3");
  });
});

describe("KrogerAuth: app token for product search", () => {
  it("uses client credentials with product.compact only, caches it, and never touches the owner's connection", async () => {
    const s = stableStore();
    let t = NOW.getTime();
    let n = 0;
    const f = fakeFetch(() => json(200, { access_token: `app-${++n}`, expires_in: 1800 }));
    const a = new KrogerAuth(CFG, s, f.fn, () => t);
    expect(await Promise.all([a.appToken(), a.appToken()])).toEqual(["app-1", "app-1"]);
    expect(form(f.calls[0]!)).toEqual({ grant_type: "client_credentials", scope: "product.compact" });
    expect(f.calls).toHaveLength(1);
    t += 1800_000;
    expect(await a.appToken()).toBe("app-2");
    expect(await s.load("kroger")).toBeNull();
  });

  it("refused app credentials are a server config error (appCredentials), never reauth", async () => {
    for (const [status, code] of [[400, "invalid_scope"], [400, "invalid_client"], [401, "invalid_client"], [403, ""]] as const) {
      const err = await new KrogerAuth(CFG, stableStore(), fakeFetch(() => json(status, { error: code })).fn).appToken().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KrogerAuthError);
      expect((err as KrogerAuthError).appCredentials).toBe(true);
      expect((err as KrogerAuthError).status).toBe(status);
    }
    const down = await new KrogerAuth(CFG, stableStore(), fakeFetch(() => json(503, {})).fn).appToken().catch((e: unknown) => e);
    expect(down).toBeInstanceOf(KrogerSignInError);
  });

  it("invalidateUser() / invalidateApp() drop only their own cached token", async () => {
    const s = stableStore();
    await connect(s);
    let n = 0;
    const f = fakeFetch(() => json(200, { access_token: `tok-${++n}`, expires_in: 1800 }));
    const a = new KrogerAuth(CFG, s, f.fn, () => NOW.getTime());
    await a.userToken();
    await a.appToken();
    a.invalidateUser();
    await a.userToken();
    await a.appToken();
    expect(f.calls).toHaveLength(3);
    expect(form(f.calls[2]!).grant_type).toBe("refresh_token");
    a.invalidateApp();
    await a.userToken();
    await a.appToken();
    expect(f.calls).toHaveLength(4);
    expect(form(f.calls[3]!).grant_type).toBe("client_credentials");
  });

  it("plugs into krogerHttpApi: search with the app token, cart add with the owner's", async () => {
    const s = stableStore();
    await connect(s);
    const tokens = fakeFetch((_u, init) => json(200, { access_token: form({ url: "", init }).grant_type === "client_credentials" ? "APP" : "USER", expires_in: 1800 }));
    const a = new KrogerAuth(CFG, s, tokens.fn, () => NOW.getTime());
    const seen: string[] = [];
    const api = krogerHttpApi({
      userToken: () => a.userToken(),
      appToken: () => a.appToken(),
      fetch: (async (url: string, init: RequestInit) => {
        seen.push(`${(init.method ?? "GET")} ${new URL(url).pathname} ${(init.headers as Record<string, string>).Authorization}`);
        return url.includes("/products") ? json(200, { data: [{ productId: "0001111041700", description: "Milk", items: [{ size: "1 gal" }] }] }) : new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const g = new KrogerGrocery(api, new MemorySearchedProducts());
    const [p] = await g.search({ query: "milk" });
    await g.addToCart({ items: [{ productId: p!.id, quantity: 1 }] });
    expect(seen).toEqual(["GET /v1/products Bearer APP", "PUT /v1/cart/add Bearer USER"]);
  });
});

describe("krogerConfigFromEnv", () => {
  it("is configured only with both client id and secret; redirect defaults to the generic connections callback", () => {
    expect(krogerConfigFromEnv("https://b.example")).toBeNull();
    process.env.KROGER_CLIENT_ID = "id";
    expect(krogerConfigFromEnv("https://b.example")).toBeNull();
    process.env.KROGER_CLIENT_SECRET = "sec";
    expect(krogerConfigFromEnv("https://b.example")).toEqual({ clientId: "id", clientSecret: "sec", redirectUri: "https://b.example/api/connections/kroger/callback" });
    process.env.KROGER_REDIRECT_URI = "https://other.example/cb";
    expect(krogerConfigFromEnv("https://b.example")?.redirectUri).toBe("https://other.example/cb");
  });
});

describe("KvSearchedProducts", () => {
  const A = "0001111041700";
  const B = "0001111041701";
  const C = "0001111041702";

  it("ids remembered in one instance are addable from another, until they expire", async () => {
    let t = NOW.getTime();
    const kv = new MemoryKV(() => t);
    await new KvSearchedProducts(kv, "t", SEARCHED_TTL_MS, () => t).remember([A, B]);
    const other = new KvSearchedProducts(kv, "t", SEARCHED_TTL_MS, () => t);
    expect(await other.missing([A, B, C])).toEqual([C]);
    t += SEARCHED_TTL_MS;
    expect(await other.missing([A, B])).toEqual([A, B]);
  });

  it("stores only well-formed product ids, under its own key", async () => {
    const kv = new MemoryKV(() => NOW.getTime());
    const s = new KvSearchedProducts(kv, "t", SEARCHED_TTL_MS, () => NOW.getTime());
    await s.remember([A, "123", "x".repeat(13), " " + B]);
    expect(Object.keys(await kv.hgetall("t:kroger:searched"))).toEqual([A]);
    expect(await s.missing([])).toEqual([]);
  });

  it("junk values in the hash count as expired and are pruned", async () => {
    const kv = new MemoryKV(() => NOW.getTime());
    await kv.hset("t:kroger:searched", B, "not-a-number");
    await kv.hset("t:kroger:searched", "bogus", String(NOW.getTime() + 1e9));
    const s = new KvSearchedProducts(kv, "t", SEARCHED_TTL_MS, () => NOW.getTime());
    expect(await s.missing([B])).toEqual([B]);
    await s.remember([A]);
    expect(Object.keys(await kv.hgetall("t:kroger:searched"))).toEqual([A]);
  });

  it("stays bounded: past maxIds the soonest-expiring ids go, never the ones just searched", async () => {
    let t = NOW.getTime();
    const kv = new MemoryKV(() => t);
    const s = new KvSearchedProducts(kv, "t", SEARCHED_TTL_MS, () => t, 3);
    const id = (i: number) => String(1_000_000_000_000 + i);
    await s.remember([id(1), id(2)]);
    t += 1000;
    await s.remember([id(3), id(4)]);
    const left = Object.keys(await kv.hgetall("t:kroger:searched")).sort();
    expect(left).toHaveLength(3);
    expect(left).toContain(id(3));
    expect(left).toContain(id(4));
    t += 1000;
    await s.remember([id(5), id(6), id(7), id(8)]); // a search bigger than the cap keeps all of it
    expect(await s.missing([id(5), id(6), id(7), id(8)])).toEqual([]);
    expect(Object.keys(await kv.hgetall("t:kroger:searched")).sort()).toEqual([id(5), id(6), id(7), id(8)]); // older ones evicted
  });

  it("a failed prune doesn't fail the search", async () => {
    const kv = new MemoryKV(() => NOW.getTime());
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(kv, "hdel").mockRejectedValue(new Error("KV down"));
    await kv.hset("t:kroger:searched", "junk", "1");
    const s = new KvSearchedProducts(kv, "t", SEARCHED_TTL_MS, () => NOW.getTime());
    await expect(s.remember([A])).resolves.toBeUndefined();
    expect(await s.missing([A])).toEqual([]);
  });

  it("works as KrogerGrocery's provenance check across requests", async () => {
    const kv = new MemoryKV(() => NOW.getTime());
    const added: unknown[] = [];
    const api = {
      searchProducts: async () => ({ data: [{ productId: A, description: "Eggs", items: [{}] }] }),
      addToCart: async (items: unknown[]) => void added.push(...items),
    };
    await new KrogerGrocery(api, new KvSearchedProducts(kv, "t")).search({ query: "eggs" });
    const later = new KrogerGrocery(api, new KvSearchedProducts(kv, "t"));
    await later.addToCart({ items: [{ productId: A, quantity: 2 }] });
    await expect(later.addToCart({ items: [{ productId: B, quantity: 1 }] })).rejects.toThrow(/recent grocery search/);
    expect(added).toEqual([{ upc: A, quantity: 2, modality: "PICKUP" }]);
  });
});
