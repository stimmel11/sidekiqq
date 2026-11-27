import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import { pkceChallenge } from "@/lib/crypto";
import { GET as listGet } from "@/app/api/connections/route";
import { GET as connectGet, POST as connectPost } from "@/app/api/connections/[connectorId]/connect/route";
import { GET as callbackGet } from "@/app/api/connections/[connectorId]/callback/route";
import { POST as disconnectPost } from "@/app/api/connections/[connectorId]/disconnect/route";
import type { Connection } from "@/lib/connectors/manage";
import { oauthFlow } from "@/lib/connectors/oauth";
import { invokeCapability } from "@/lib/connectors/invoke";
import { GroceryCartAddInput, GrocerySearchInput } from "@/lib/connectors/capabilities";
import { CapabilityDeniedError, ConnectionUnusableError, ReauthRequiredError } from "@/lib/connectors/types";
import type { ConnectionStore } from "@/lib/connectors/store";
import type { FetchLike } from "@/lib/connectors/zoom/auth";
import { KrogerConnector, krogerAuthedApi } from "@/lib/connectors/kroger";
import { KROGER_OAUTH_BASE, KROGER_USER_SCOPES, KrogerAuth, KrogerNotConnectedError } from "@/lib/connectors/kroger/auth";
import {
  GroceryInputError,
  KrogerAuthError,
  KrogerCartRefusedError,
  KrogerCartUncertainError,
  KrogerGrocery,
  type KrogerApi,
  type Modality,
} from "@/lib/kroger/grocery";
import { KvSearchedProducts } from "@/lib/kroger/searched";
import { makeDeps, params, req, type TestDeps } from "./fakes";

const OWNER = { "x-owner-secret": "test-owner-secret-0123456789" };
const CFG = { clientId: "kcid", clientSecret: "ksecret", redirectUri: "https://brain.example.com/api/connections/kroger/callback" };
const P = params({ connectorId: "kroger" });
const NOW = new Date("2026-11-26T15:00:00Z");
const MILK = "0001111041700";
const EGGS = "0001111060933";

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const productsBody = (ids = [MILK]) => ({ data: ids.map((id, n) => ({ productId: id, description: `Product ${n}`, items: [{ size: "1 gal", price: { regular: 3.49 } }] })) });

/** Records what the connector asked Kroger for (no network). */
class FakeKrogerApi implements KrogerApi {
  searches: { term: string; locationId?: string; limit: number }[] = [];
  adds: { upc: string; quantity: number; modality: Modality }[][] = [];
  ids = [MILK, EGGS];
  addError: Error | null = null;
  async searchProducts(p: { term: string; locationId?: string; limit: number }): Promise<unknown> {
    this.searches.push(p);
    return productsBody(this.ids);
  }
  async addToCart(items: { upc: string; quantity: number; modality: Modality }[]): Promise<void> {
    if (this.addError) throw this.addError;
    this.adds.push(items);
  }
}

function fakeFetch(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  }) as FetchLike & typeof fetch;
  return { fn, calls };
}

async function connect(c: ConnectionStore, secret = "k-rt-1", grantedScopes: string[] = [...KROGER_USER_SCOPES]) {
  await c.save("kroger", { secret, secretKind: "refresh_token", grantedScopes, connectedAt: NOW.toISOString() });
}

beforeEach(() => {
  process.env.APP_URL = "https://brain.example.com";
});
afterEach(() => {
  delete process.env.APP_URL;
  setDeps(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------
// OAuth flow behind /api/connections/kroger/*
// ---------------------------------------------------------------------------------------

describe("Kroger connect (generic /api/connections/kroger/*)", () => {
  function krogerDeps(handler: (url: string, init: RequestInit) => Response = () => tokenOk()) {
    const f = fakeFetch(handler);
    const deps = makeDeps({ now: NOW, kroger: new FakeKrogerApi(), krogerAuth: (c) => new KrogerAuth(CFG, c, f.fn) });
    setDeps(deps);
    return { deps, calls: f.calls };
  }
  const tokenOk = (refresh = "k-rt-NEW", scope = KROGER_USER_SCOPES.join(" ")) =>
    json(200, { access_token: "k-at-1", refresh_token: refresh, expires_in: 1800, scope, token_type: "bearer" });

  async function callback(query: string): Promise<string | null> {
    const res = await callbackGet(req("GET", `/api/connections/kroger/callback?${query}`), P);
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/dashboard/connections");
    expect(to.searchParams.get("connector")).toBe("kroger");
    return to.searchParams.get("connect");
  }
  async function krogerRow(): Promise<Connection> {
    const res = await listGet(req("GET", "/api/connections", { headers: OWNER }), params({}));
    return ((await res.json()) as { items: Connection[] }).items.find((c) => c.connectorId === "kroger")!;
  }

  it("has an OAuth flow registered under the connector id, with no revoke (Kroger documents none)", () => {
    expect(oauthFlow("kroger")).toBeDefined();
    expect(oauthFlow("kroger")!.revoke).toBeUndefined();
  });

  it("connect redirects to Kroger's authorize page with PKCE S256, minimal scopes and a single-use state", async () => {
    const { deps, calls } = krogerDeps();
    const res = await connectPost(req("POST", "/api/connections/kroger/connect", { headers: OWNER }), P);
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const go = await connectGet(req("GET", new URL(url).pathname + new URL(url).search), P);
    expect(go.status).toBe(307);
    const loc = new URL(go.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(`${KROGER_OAUTH_BASE}/authorize`);
    expect(loc.searchParams.get("client_id")).toBe("kcid");
    expect(loc.searchParams.get("scope")).toBe("product.compact cart.basic:write");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.toString()).not.toContain("ksecret");
    const verifier = await deps.connections.consumeState("kroger", loc.searchParams.get("state")!);
    expect(pkceChallenge(verifier!)).toBe(loc.searchParams.get("code_challenge"));
    expect(calls).toHaveLength(0);
  });

  it("is a 404 when Kroger isn't configured (the connector isn't registered)", async () => {
    setDeps(makeDeps());
    expect((await connectPost(req("POST", "/api/connections/kroger/connect", { headers: OWNER }), P)).status).toBe(404);
  });

  it("callback exchanges the code with the verifier, stores the refresh token, and is single use", async () => {
    const { deps, calls } = krogerDeps();
    const verifier = "kroger-verifier-abcdefghijklmnopqrstuvwxyz-0123";
    const state = await deps.connections.issueState("kroger", verifier);
    expect(await callback(`code=kc-1&state=${state}`)).toBe("connected");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${KROGER_OAUTH_BASE}/token`);
    const f = new URLSearchParams(String(calls[0]!.init.body));
    expect(f.get("grant_type")).toBe("authorization_code");
    expect(f.get("code_verifier")).toBe(verifier);
    expect(await deps.connections.load("kroger")).toMatchObject({ secret: "k-rt-NEW", status: "connected", grantedScopes: [...KROGER_USER_SCOPES] });

    const row = await krogerRow();
    expect(row.status).toBe("connected");
    expect(row.capabilities.map((c) => c.id).sort()).toEqual(["grocery.cart.add", "grocery.search"]);
    expect(JSON.stringify(row)).not.toContain("k-rt");

    expect(await callback(`code=kc-1&state=${state}`)).toBe("expired");
    expect(calls).toHaveLength(1);
  });

  it("refuses cancelled / malformed / other-connector states without calling Kroger", async () => {
    const { deps, calls } = krogerDeps();
    expect(await callback("error=access_denied&state=x")).toBe("cancelled");
    expect(await callback("code=kc-1")).toBe("invalid");
    const zoomState = await deps.connections.issueState("zoom", "zoom-verifier-abcdefghijklmnopqrstuvwxyz-0123");
    expect(await callback(`code=kc-1&state=${zoomState}`)).toBe("expired");
    expect(calls).toHaveLength(0);
  });

  it("a failed exchange or a missing refresh token stores nothing and never logs Kroger's reply", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let reply = json(400, { error: "invalid_request", error_description: "leaked-token-material-xyz" });
    const { deps } = krogerDeps(() => reply);
    let state = await deps.connections.issueState("kroger", "kroger-verifier-abcdefghijklmnopqrstuvwxyz-0123");
    expect(await callback(`code=kc-1&state=${state}`)).toBe("failed");
    reply = json(200, { access_token: "k-at-secret", expires_in: 1800 });
    state = await deps.connections.issueState("kroger", "kroger-verifier-abcdefghijklmnopqrstuvwxyz-0456");
    expect(await callback(`code=kc-2&state=${state}`)).toBe("failed");
    expect(await deps.connections.load("kroger")).toBeNull();
    const logged = JSON.stringify(errSpy.mock.calls);
    expect(logged).not.toContain("leaked-token-material-xyz");
    expect(logged).not.toContain("k-at-secret");
  });

  it("callback answers failed (after burning the state) when Kroger isn't configured", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const state = await deps.connections.issueState("kroger", "kroger-verifier-abcdefghijklmnopqrstuvwxyz-0123");
    expect(await callback(`code=kc-1&state=${state}`)).toBe("failed");
    expect(await deps.connections.consumeState("kroger", state)).toBeNull();
  });

  it("disconnect deletes the stored token without calling Kroger", async () => {
    const { deps, calls } = krogerDeps();
    await connect(deps.connections);
    const res = await disconnectPost(req("POST", "/api/connections/kroger/disconnect", { headers: OWNER }), P);
    expect(res.status).toBe(200);
    expect(await deps.connections.load("kroger")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// The 401 retry rule
// ---------------------------------------------------------------------------------------

describe("krogerAuthedApi: one retry after a 401, nothing else", () => {
  function auth() {
    let user = 0;
    let app = 0;
    return {
      userToken: vi.fn(async () => `user-${++user}`),
      appToken: vi.fn(async () => `app-${++app}`),
      invalidateUser: vi.fn(),
      invalidateApp: vi.fn(),
    };
  }
  const bearer = (c: Call) => (c.init.headers as Record<string, string>).Authorization;
  const ITEMS = [{ upc: MILK, quantity: 1, modality: "PICKUP" as const }];

  it("search: 401 → drop the app token and retry once with a new one", async () => {
    const a = auth();
    const f = fakeFetch((_u, _i, n) => (n === 1 ? json(401, {}) : json(200, productsBody())));
    const out = await krogerAuthedApi(a, f.fn).searchProducts({ term: "milk", limit: 5 });
    expect((out as { data: unknown[] }).data).toHaveLength(1);
    expect(f.calls.map(bearer)).toEqual(["Bearer app-1", "Bearer app-2"]);
    expect(a.invalidateApp).toHaveBeenCalledTimes(1);
    expect(a.invalidateUser).not.toHaveBeenCalled();
    expect(a.userToken).not.toHaveBeenCalled();
  });

  it("search: a second 401 is an app-credentials problem, not the owner's", async () => {
    const a = auth();
    const f = fakeFetch(() => json(401, {}));
    const err = await krogerAuthedApi(a, f.fn).searchProducts({ term: "milk", limit: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KrogerAuthError);
    expect((err as KrogerAuthError).appCredentials).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it("cart add: 401 → refresh the owner token once and retry (nothing was applied)", async () => {
    const a = auth();
    const f = fakeFetch((_u, _i, n) => (n === 1 ? json(401, {}) : new Response(null, { status: 204 })));
    await krogerAuthedApi(a, f.fn).addToCart(ITEMS);
    expect(f.calls.map(bearer)).toEqual(["Bearer user-1", "Bearer user-2"]);
    expect(f.calls.every((c) => c.url.endsWith("/cart/add") && c.init.method === "PUT")).toBe(true);
    expect(a.invalidateUser).toHaveBeenCalledTimes(1);
  });

  it("cart add: 403, 429, 4xx, 5xx and timeouts are never retried", async () => {
    for (const [reply, type] of [
      [() => json(403, {}), KrogerAuthError],
      [() => json(400, {}), KrogerCartRefusedError],
      [() => json(502, {}), KrogerCartUncertainError],
      [
        () => {
          throw Object.assign(new Error("t"), { name: "TimeoutError" });
        },
        KrogerCartUncertainError,
      ],
    ] as const) {
      const a = auth();
      const f = fakeFetch(reply as () => Response);
      await expect(krogerAuthedApi(a, f.fn).addToCart(ITEMS)).rejects.toBeInstanceOf(type);
      expect(f.calls).toHaveLength(1);
      expect(a.invalidateUser).not.toHaveBeenCalled();
    }
    const a = auth();
    const f = fakeFetch(() => json(429, {}));
    await expect(krogerAuthedApi(a, f.fn).addToCart(ITEMS)).rejects.toThrow(/rate limit/);
    expect(f.calls).toHaveLength(1);
  });

  it("cart add: a second 401 is not retried again", async () => {
    const a = auth();
    const f = fakeFetch(() => json(401, {}));
    await expect(krogerAuthedApi(a, f.fn).addToCart(ITEMS)).rejects.toBeInstanceOf(KrogerAuthError);
    expect(f.calls).toHaveLength(2);
  });

  it("a refusal from the token endpoint itself is passed through, not retried", async () => {
    const a = auth();
    a.appToken.mockRejectedValue(new KrogerAuthError(401, true));
    const f = fakeFetch(() => json(200, productsBody()));
    await expect(krogerAuthedApi(a, f.fn).searchProducts({ term: "milk", limit: 5 })).rejects.toBeInstanceOf(KrogerAuthError);
    expect(a.appToken).toHaveBeenCalledTimes(1);
    expect(a.invalidateApp).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// grocery.search / grocery.cart.add through invokeCapability
// ---------------------------------------------------------------------------------------

describe("grocery capabilities through invokeCapability", () => {
  function setup(): TestDeps & { api: FakeKrogerApi } {
    const api = new FakeKrogerApi();
    const deps = makeDeps({ now: NOW, kroger: api });
    setDeps(deps);
    return Object.assign(deps, { api });
  }

  it("search needs the owner's Kroger connection, though it runs on the app token", async () => {
    const deps = setup();
    await expect(invokeCapability(deps, "grocery.search", { query: "milk" }, { caller: "ask" })).rejects.toBeInstanceOf(KrogerNotConnectedError);
    expect(deps.api.searches).toHaveLength(0);
  });

  it("search runs on a connected Kroger and audits the query", async () => {
    const deps = setup();
    await connect(deps.connections);
    const out = await invokeCapability(deps, "grocery.search", { query: "2% milk", locationId: "01400943", max: 5 }, { caller: "ask", device: "phone" });
    expect(out.map((p) => p.id)).toEqual([MILK, EGGS]);
    expect(deps.api.searches).toEqual([{ term: "2% milk", locationId: "01400943", limit: 5 }]);
    const [row] = await deps.repos.audit.recent();
    expect(row).toMatchObject({ connector: "kroger", capability: "grocery.search", tier: "auto", caller: "ask", ok: true });
    expect(row?.summary).toBe('grocery search "2% milk" at store 01400943');
    expect(row?.args).toContain("2% milk"); // not first-party: arguments are logged
  });

  it("adds only searched products, merged, with no checkout or payment call", async () => {
    const deps = setup();
    await connect(deps.connections);
    await invokeCapability(deps, "grocery.search", { query: "milk and eggs" }, { caller: "ask" });
    const out = await invokeCapability(
      deps,
      "grocery.cart.add",
      { items: [{ productId: MILK, quantity: 1 }, { productId: EGGS, quantity: 2 }, { productId: MILK, quantity: 1 }] },
      { caller: "ask" },
    );
    expect(out).toEqual({ ok: true, count: 2 });
    expect(deps.api.adds).toEqual([
      [
        { upc: MILK, quantity: 2, modality: "PICKUP" },
        { upc: EGGS, quantity: 2, modality: "PICKUP" },
      ],
    ]);
    const [row] = await deps.repos.audit.recent();
    expect(row?.summary).toBe("cart add: 3 lines, 4 items");
  });

  it("the owner's off switch stops search and cart add separately", async () => {
    const deps = setup();
    await deps.connections.save("kroger", { secret: "k-rt-1", secretKind: "refresh_token", grantedScopes: [...KROGER_USER_SCOPES], connectedAt: NOW.toISOString(), enabled: ["grocery.cart.add"] });
    await expect(invokeCapability(deps, "grocery.search", { query: "milk" }, { caller: "ask" })).rejects.toBeInstanceOf(ConnectionUnusableError);
    expect(deps.api.searches).toHaveLength(0);
    await deps.connections.save("kroger", { secret: "k-rt-1", secretKind: "refresh_token", grantedScopes: [...KROGER_USER_SCOPES], connectedAt: NOW.toISOString(), enabled: ["grocery.search"] });
    await invokeCapability(deps, "grocery.search", { query: "milk" }, { caller: "ask" });
    await expect(invokeCapability(deps, "grocery.cart.add", { items: [{ productId: MILK, quantity: 1 }] }, { caller: "ask" })).rejects.toBeInstanceOf(ConnectionUnusableError);
    expect(deps.api.adds).toHaveLength(0);
  });

  it("refuses a product id that no search returned, before any cart call", async () => {
    const deps = setup();
    await connect(deps.connections);
    await expect(invokeCapability(deps, "grocery.cart.add", { items: [{ productId: "0009999999999", quantity: 1 }] }, { caller: "ask" })).rejects.toBeInstanceOf(
      GroceryInputError,
    );
    expect(deps.api.adds).toHaveLength(0);
  });

  it("a searched id stays addable from a later request (KV-backed provenance)", async () => {
    const deps = setup();
    await connect(deps.connections);
    await invokeCapability(deps, "grocery.search", { query: "milk" }, { caller: "ask" });
    // A new connector instance (as in a new serverless invocation) over the same KV.
    const later = { ...deps, connectors: () => [new KrogerConnector(async () => new KrogerGrocery(deps.api, new KvSearchedProducts(deps.kv, "t", undefined, () => NOW.getTime())), deps.connections)] };
    await expect(invokeCapability(later, "grocery.cart.add", { items: [{ productId: MILK, quantity: 1 }] }, { caller: "ask" })).resolves.toEqual({ ok: true, count: 1 });
  });

  it("background callers can't search or add", async () => {
    const deps = setup();
    for (const caller of ["cron", "brief"] as const) {
      await expect(invokeCapability(deps, "grocery.search", { query: "milk" }, { caller })).rejects.toBeInstanceOf(CapabilityDeniedError);
      await expect(invokeCapability(deps, "grocery.cart.add", { items: [{ productId: MILK, quantity: 1 }] }, { caller })).rejects.toBeInstanceOf(CapabilityDeniedError);
    }
    expect(deps.api.searches).toHaveLength(0);
  });

  it("checkout is never runnable through invokeCapability", async () => {
    const deps = setup();
    await expect(invokeCapability(deps, "grocery.checkout", {}, { caller: "ask" })).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  it("schemas refuse UPCs, codes, URLs, too many lines and big quantities before Kroger sees them", async () => {
    const deps = setup();
    await connect(deps.connections);
    for (const query of ["a".repeat(81), "0001111041700", "call 303-555-1234", "https://evil.example/x", "dana%40acme.com", "ab", "one two three four five six seven eight nine"]) {
      expect(GrocerySearchInput.safeParse({ query }).success, query).toBe(false);
      await expect(invokeCapability(deps, "grocery.search", { query }, { caller: "ask" })).rejects.toBeInstanceOf(CapabilityDeniedError);
    }
    expect(GrocerySearchInput.safeParse({ query: "2% milk 1/2 gallon" }).success).toBe(true);
    expect(GrocerySearchInput.safeParse({ query: "a".repeat(80) }).success).toBe(true);
    expect(GrocerySearchInput.safeParse({ query: "milk", locationId: "../x" }).success).toBe(false);
    expect(GrocerySearchInput.safeParse({ query: "milk", max: 26 }).success).toBe(false);
    expect(GroceryCartAddInput.safeParse({ items: [] }).success).toBe(false);
    expect(GroceryCartAddInput.safeParse({ items: [{ productId: MILK, quantity: 11 }] }).success).toBe(false);
    expect(GroceryCartAddInput.safeParse({ items: [{ productId: MILK, quantity: 0 }] }).success).toBe(false);
    expect(GroceryCartAddInput.safeParse({ items: [{ productId: "123", quantity: 1 }] }).success).toBe(false);
    expect(GroceryCartAddInput.safeParse({ items: Array.from({ length: 51 }, () => ({ productId: MILK, quantity: 1 })) }).success).toBe(false);
    expect(deps.api.searches).toHaveLength(0);
  });

  it("an ungranted cart scope disables cart add but not search", async () => {
    const deps = setup();
    await connect(deps.connections, "k-rt-1", ["product.compact"]); // cart scope not granted
    await invokeCapability(deps, "grocery.search", { query: "milk" }, { caller: "ask" });
    await expect(invokeCapability(deps, "grocery.cart.add", { items: [{ productId: MILK, quantity: 1 }] }, { caller: "ask" })).rejects.toBeInstanceOf(
      ConnectionUnusableError,
    );
    expect(deps.api.adds).toHaveLength(0);
  });

  it("an uncertain add is surfaced as such (the caller must not retry)", async () => {
    const deps = setup();
    await connect(deps.connections);
    await invokeCapability(deps, "grocery.search", { query: "milk" }, { caller: "ask" });
    deps.api.addError = new KrogerCartUncertainError("timed out");
    await expect(invokeCapability(deps, "grocery.cart.add", { items: [{ productId: MILK, quantity: 1 }] }, { caller: "ask" })).rejects.toBeInstanceOf(
      KrogerCartUncertainError,
    );
    expect((await deps.connections.load("kroger"))?.status).toBe("connected");
  });
});

describe("Kroger end to end over a fake Kroger (real KrogerAuth + HTTP layer)", () => {
  function real(handler: (url: string, init: RequestInit, n: number) => Response) {
    const deps = makeDeps({ now: NOW });
    const f = fakeFetch(handler);
    const auth = new KrogerAuth(CFG, deps.connections, f.fn, () => NOW.getTime());
    const grocery = new KrogerGrocery(krogerAuthedApi(auth, f.fn), new KvSearchedProducts(deps.kv, "t", undefined, () => NOW.getTime()));
    const d = { ...deps, connectors: () => [new KrogerConnector(async () => grocery, deps.connections)] };
    setDeps(d);
    return { deps: d, calls: f.calls };
  }
  const tokenFor = (init: RequestInit) => new URLSearchParams(String(init.body)).get("grant_type");

  it("a dead refresh token on a cart add marks needs_reauth, alerts once, and adds nothing", async () => {
    const { deps, calls } = real((url, init) => {
      if (url.endsWith("/token")) return tokenFor(init) === "client_credentials" ? json(200, { access_token: "app", expires_in: 1800 }) : json(400, { error: "invalid_grant" });
      if (url.includes("/products")) return json(200, productsBody());
      return new Response(null, { status: 204 });
    });
    await connect(deps.connections, "k-rt-DEAD");
    await invokeCapability(deps, "grocery.search", { query: "milk" }, { caller: "ask" });
    await expect(invokeCapability(deps, "grocery.cart.add", { items: [{ productId: MILK, quantity: 1 }] }, { caller: "ask" })).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
    expect((await deps.connections.load("kroger"))?.status).toBe("needs_reauth");
    expect(calls.some((c) => c.url.includes("/cart/add"))).toBe(false);
    const alerts = (await deps.repos.alerts.since(null)).items;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "connection_needs_reauth", title: "Reconnect Kroger" });
  });

  it("a broken app credential never marks the owner's connection needs_reauth", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps } = real((url) => (url.endsWith("/token") ? json(401, { error: "invalid_client" }) : json(200, productsBody())));
    await connect(deps.connections);
    const err = await invokeCapability(deps, "grocery.search", { query: "milk" }, { caller: "ask" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KrogerAuthError);
    expect((err as KrogerAuthError).appCredentials).toBe(true);
    expect((await deps.connections.load("kroger"))?.status).toBe("connected");
  });

  it("without a Kroger connection nothing at all reaches Kroger", async () => {
    const { deps, calls } = real((url) => (url.endsWith("/token") ? json(200, { access_token: "app", expires_in: 1800 }) : json(200, productsBody())));
    await expect(invokeCapability(deps, "grocery.search", { query: "milk" }, { caller: "ask" })).rejects.toBeInstanceOf(KrogerNotConnectedError);
    await expect(invokeCapability(deps, "grocery.cart.add", { items: [{ productId: MILK, quantity: 1 }] }, { caller: "ask" })).rejects.toBeInstanceOf(
      KrogerNotConnectedError,
    );
    expect(calls).toHaveLength(0);
  });

  it("cart add 401, then a dead refresh: needs_reauth, one alert, exactly one cart call", async () => {
    let userRefreshes = 0;
    const { deps, calls } = real((url, init) => {
      if (url.endsWith("/token")) {
        if (tokenFor(init) === "client_credentials") return json(200, { access_token: "app", expires_in: 1800 });
        return ++userRefreshes === 1 ? json(200, { access_token: "user-1", refresh_token: "k-rt-1", expires_in: 1800 }) : json(400, { error: "invalid_grant" });
      }
      if (url.includes("/products")) return json(200, productsBody());
      return json(401, {});
    });
    await connect(deps.connections);
    await invokeCapability(deps, "grocery.search", { query: "milk" }, { caller: "ask" });
    await expect(invokeCapability(deps, "grocery.cart.add", { items: [{ productId: MILK, quantity: 1 }] }, { caller: "ask" })).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
    expect(calls.filter((c) => c.url.includes("/cart/add"))).toHaveLength(1);
    expect((await deps.connections.load("kroger"))?.status).toBe("needs_reauth");
    expect((await deps.repos.alerts.since(null)).items).toHaveLength(1);
  });

  it("a search 401 through the real KrogerAuth mints a fresh app token", async () => {
    let appMints = 0;
    let searches = 0;
    const { deps, calls } = real((url, init) => {
      if (url.endsWith("/token") && tokenFor(init) === "client_credentials") return json(200, { access_token: `app-${++appMints}`, expires_in: 1800 });
      return ++searches === 1 ? json(401, {}) : json(200, productsBody());
    });
    await connect(deps.connections);
    await expect(invokeCapability(deps, "grocery.search", { query: "milk" }, { caller: "ask" })).resolves.toHaveLength(1);
    expect(appMints).toBe(2);
    const auths = calls.filter((c) => c.url.includes("/products")).map((c) => (c.init.headers as Record<string, string>).Authorization);
    expect(auths).toEqual(["Bearer app-1", "Bearer app-2"]);
  });

  it("the full happy path: app-token search, owner-token add after one expired-token 401", async () => {
    let cartCalls = 0;
    const { deps, calls } = real((url, init) => {
      if (url.endsWith("/token")) {
        return tokenFor(init) === "client_credentials"
          ? json(200, { access_token: "app", expires_in: 1800 })
          : json(200, { access_token: `user-${calls.length}`, refresh_token: "k-rt-1", expires_in: 1800 });
      }
      if (url.includes("/products")) return json(200, productsBody());
      return ++cartCalls === 1 ? json(401, {}) : new Response(null, { status: 204 });
    });
    await connect(deps.connections);
    await invokeCapability(deps, "grocery.search", { query: "milk" }, { caller: "ask" });
    await expect(invokeCapability(deps, "grocery.cart.add", { items: [{ productId: MILK, quantity: 3 }] }, { caller: "ask" })).resolves.toEqual({ ok: true, count: 1 });
    const adds = calls.filter((c) => c.url.includes("/cart/add"));
    expect(adds).toHaveLength(2);
    expect(JSON.parse(String(adds[1]!.init.body))).toEqual({ items: [{ upc: MILK, quantity: 3, modality: "PICKUP" }] });
    expect(calls.filter((c) => /checkout|order|payment/i.test(c.url))).toHaveLength(0);
    expect((await deps.connections.load("kroger"))?.status).toBe("connected");
  });
});
