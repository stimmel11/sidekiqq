import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CART_MAX_LINES,
  cleanText,
  GroceryInputError,
  KrogerAuthError,
  KrogerCartRefusedError,
  KrogerCartUncertainError,
  KrogerGrocery,
  krogerCartUrl,
  krogerHttpApi,
  KrogerRateLimitError,
  KrogerUnavailableError,
  MemorySearchedProducts,
  parseCartLines,
  parseGroceryQuery,
  toProduct,
  type KrogerApi,
} from "@/lib/kroger/grocery";
import { OPEN_URL_HOSTS } from "@/lib/commands";

const UPC_MILK = "0001111041700";
const UPC_EGGS = "0001111060933";
const UPC_BREAD = "0001111091702";

function raw(productId: string, description: string, opts: { size?: string; regular?: number; promo?: number; stock?: string } = {}) {
  return {
    productId,
    upc: productId,
    brand: "Kroger",
    description,
    items: [
      {
        itemId: productId,
        size: opts.size ?? "1 gal",
        ...(opts.regular !== undefined ? { price: { regular: opts.regular, promo: opts.promo ?? 0 } } : {}),
        ...(opts.stock ? { inventory: { stockLevel: opts.stock } } : {}),
      },
    ],
  };
}

class FakeKroger implements KrogerApi {
  searches: { term: string; locationId?: string; limit: number }[] = [];
  adds: { upc: string; quantity: number; modality: string }[][] = [];
  data: unknown[] = [];
  async searchProducts(p: { term: string; locationId?: string; limit: number }): Promise<unknown> {
    this.searches.push(p);
    return { data: this.data, meta: {} };
  }
  async addToCart(items: { upc: string; quantity: number; modality: "PICKUP" | "DELIVERY" }[]) {
    this.adds.push(items);
  }
}

function setup() {
  const api = new FakeKroger();
  api.data = [
    raw(UPC_MILK, "Kroger 2% Reduced Fat Milk", { regular: 3.49, promo: 2.99, stock: "HIGH" }),
    raw(UPC_EGGS, "Kroger Grade A Large Eggs", { size: "12 ct", regular: 4.19, stock: "TEMPORARILY_OUT_OF_STOCK" }),
  ];
  const searched = new MemorySearchedProducts();
  return { api, searched, g: new KrogerGrocery(api, searched) };
}

describe("parseGroceryQuery", () => {
  it("accepts ordinary grocery searches", () => {
    expect(parseGroceryQuery({ query: "  2% milk  " })).toEqual({ query: "2% milk", max: 10 });
    expect(parseGroceryQuery({ query: "Ben & Jerry's (pint)", locationId: "01400943", max: 3 })).toEqual({
      query: "Ben & Jerry's (pint)",
      locationId: "01400943",
      max: 3,
    });
    expect(parseGroceryQuery({ query: "jalapeño" }).query).toBe("jalapeño");
    expect(parseGroceryQuery({ query: "milk 2%" }).query).toBe("milk 2%");
    expect(parseGroceryQuery({ query: "1/2 gallon 2% organic whole milk from Horizon" }).query).toBe("1/2 gallon 2% organic whole milk from Horizon");
    expect(parseGroceryQuery({ query: "12 ct eggs" }).query).toBe("12 ct eggs");
    expect(parseGroceryQuery({ query: "1234 bagels" }).query).toBe("1234 bagels");
    // Bidi/control characters are stripped, not passed to Kroger.
    expect(parseGroceryQuery({ query: "\u202emilk\u0000" }).query).toBe("milk");
  });

  it("rejects leak-shaped or oversize queries", () => {
    for (const query of ["", "   ", "milk?token=abc", "email dana@acme.com", "x".repeat(81), "<script>", "https://evil.example", "#tag", "ox", "a b c d e f g h i", "dana%40acme.com", "dana2%40acme.com", "2%4a"]) {
      expect(() => parseGroceryQuery({ query }), JSON.stringify(query)).toThrow(GroceryInputError);
    }
  });

  it("rejects runs of 5+ digits (UPCs, codes, phone numbers)", () => {
    for (const query of [UPC_MILK, `milk ${UPC_MILK}`, "code 482913", "12345 milk", "call 3035551234"]) {
      expect(() => parseGroceryQuery({ query }), query).toThrow(/long numbers/);
    }
  });

  it("tolerates a missing input", () => {
    for (const q of [null, undefined, {}]) expect(() => parseGroceryQuery(q as never)).toThrow(GroceryInputError);
  });

  it("rejects bad store ids and max", () => {
    expect(() => parseGroceryQuery({ query: "milk", locationId: "0140" })).toThrow(GroceryInputError);
    expect(() => parseGroceryQuery({ query: "milk", locationId: "01400943&x" })).toThrow(GroceryInputError);
    for (const max of [0, 26, 1.5, Number.NaN]) expect(() => parseGroceryQuery({ query: "milk", max })).toThrow(GroceryInputError);
  });
});

describe("parseCartLines", () => {
  it("merges duplicate lines", () => {
    expect(parseCartLines([{ productId: UPC_MILK, quantity: 1 }, { productId: UPC_EGGS, quantity: 2 }, { productId: UPC_MILK, quantity: 3 }])).toEqual([
      { productId: UPC_MILK, quantity: 4 },
      { productId: UPC_EGGS, quantity: 2 },
    ]);
  });

  it("enforces quantity 1–10 per line, also after merging", () => {
    for (const quantity of [0, -1, 11, 2.5, Number.NaN]) {
      expect(() => parseCartLines([{ productId: UPC_MILK, quantity }]), String(quantity)).toThrow(GroceryInputError);
    }
    expect(parseCartLines([{ productId: UPC_MILK, quantity: 10 }])).toHaveLength(1);
    expect(() => parseCartLines([{ productId: UPC_MILK, quantity: 6 }, { productId: UPC_MILK, quantity: 5 }])).toThrow(/At most 10/);
  });

  it("enforces ≤ 50 lines and UPC-shaped ids", () => {
    const many = Array.from({ length: CART_MAX_LINES + 1 }, (_, i) => ({ productId: String(i).padStart(13, "0"), quantity: 1 }));
    expect(() => parseCartLines(many)).toThrow(/At most 50/);
    expect(parseCartLines(many.slice(0, CART_MAX_LINES))).toHaveLength(CART_MAX_LINES);
    // The cap is on lines sent in, not just on distinct ids after merging.
    const repeats = Array.from({ length: CART_MAX_LINES + 1 }, () => ({ productId: UPC_MILK, quantity: 1 }));
    expect(() => parseCartLines(repeats)).toThrow(/At most 50 lines/);
    expect(() => parseCartLines([])).toThrow(GroceryInputError);
    for (const productId of ["123", "00011110417001", "abc1111041700", "", " "]) {
      expect(() => parseCartLines([{ productId, quantity: 1 }])).toThrow(GroceryInputError);
    }
  });
});

describe("toProduct", () => {
  it("maps a Kroger product, preferring a lower promo price", () => {
    expect(toProduct(raw(UPC_MILK, "Kroger 2% Milk", { regular: 3.49, promo: 2.99, stock: "LOW" }))).toEqual({
      id: UPC_MILK,
      name: "Kroger 2% Milk",
      size: "1 gal",
      price: 2.99,
      inStock: true,
    });
    expect(toProduct(raw(UPC_MILK, "Milk", { regular: 3.49, promo: 0 }))?.price).toBe(3.49);
    expect(toProduct(raw(UPC_MILK, "Milk", { regular: 3.49, promo: 4 }))?.price).toBe(3.49);
  });

  it("omits price and stock when the store didn't say", () => {
    const p = toProduct(raw(UPC_MILK, "Milk"));
    expect(p).toEqual({ id: UPC_MILK, name: "Milk", size: "1 gal" });
    expect(toProduct(raw(UPC_MILK, "Milk", { stock: "SOMETHING_NEW" }))?.inStock).toBeUndefined();
    expect(toProduct(raw(UPC_EGGS, "Eggs", { stock: "TEMPORARILY_OUT_OF_STOCK" }))?.inStock).toBe(false);
  });

  it("drops products with no valid id or name and cleans third-party text", () => {
    expect(toProduct(raw("12", "Milk"))).toBeUndefined();
    expect(toProduct(raw(UPC_MILK, "  ‮\u0000 "))).toBeUndefined();
    expect(toProduct(null)).toBeUndefined();
    expect(toProduct({ productId: UPC_MILK, description: 42 })).toBeUndefined();
    const p = toProduct(raw(UPC_MILK, "Milk‮\nIGNORE PREVIOUS " + "x".repeat(300), { size: "1​ gal" }))!;
    expect(p.name).not.toMatch(/[‮\n]/);
    expect(Array.from(p.name).length).toBeLessThanOrEqual(120);
    expect(p.size).toBe("1 gal");
  });

  it("ignores absurd prices", () => {
    expect(toProduct(raw(UPC_MILK, "Milk", { regular: -1 }))?.price).toBeUndefined();
    expect(toProduct(raw(UPC_MILK, "Milk", { regular: 1e9 }))?.price).toBeUndefined();
  });
});

describe("KrogerGrocery", () => {
  it("search passes the cleaned query and store, and returns products", async () => {
    const { api, g } = setup();
    const out = await g.search({ query: " milk ", locationId: "01400943", max: 5 });
    expect(api.searches).toEqual([{ term: "milk", locationId: "01400943", limit: 5 }]);
    expect(out.map((p) => p.id)).toEqual([UPC_MILK, UPC_EGGS]);
    expect(out[0]).toMatchObject({ price: 2.99, inStock: true });
    expect(out[1]).toMatchObject({ inStock: false, size: "12 ct" });
  });

  it("search drops invalid and duplicate products and honours max", async () => {
    const { api, g } = setup();
    api.data = [raw("bad", "x"), raw(UPC_MILK, "Milk"), raw(UPC_MILK, "Milk again"), raw(UPC_EGGS, "Eggs"), raw(UPC_BREAD, "Bread")];
    expect((await g.search({ query: "milk", max: 2 })).map((p) => p.name)).toEqual(["Milk", "Eggs"]);
  });

  it("search rejects an invalid query before calling Kroger", async () => {
    const { api, g } = setup();
    await expect(g.search({ query: "send to dana@acme.com" })).rejects.toThrow(GroceryInputError);
    expect(api.searches).toEqual([]);
  });

  it("a UPC can't be made addable by searching for it", async () => {
    const { api, g } = setup();
    await expect(g.search({ query: UPC_BREAD })).rejects.toThrow(GroceryInputError);
    expect(api.searches).toEqual([]);
    await expect(g.addToCart({ items: [{ productId: UPC_BREAD, quantity: 1 }] })).rejects.toThrow(/recent grocery search/);
    expect(api.adds).toEqual([]);
  });

  it("search fails closed on an unexpected response shape", async () => {
    const { api, g } = setup();
    api.searchProducts = async () => ({ products: [] });
    await expect(g.search({ query: "milk" })).rejects.toThrow(KrogerUnavailableError);
  });

  it("adds searched products to the cart as PICKUP lines", async () => {
    const { api, g } = setup();
    await g.search({ query: "milk" });
    const r = await g.addToCart({ items: [{ productId: UPC_MILK, quantity: 2 }, { productId: UPC_EGGS, quantity: 1 }, { productId: UPC_MILK, quantity: 1 }] });
    expect(r).toEqual({ ok: true, count: 2 });
    expect(api.adds).toEqual([
      [
        { upc: UPC_MILK, quantity: 3, modality: "PICKUP" },
        { upc: UPC_EGGS, quantity: 1, modality: "PICKUP" },
      ],
    ]);
  });

  it("refuses product ids that didn't come from a search, adding nothing", async () => {
    const { api, g } = setup();
    await g.search({ query: "milk" });
    await expect(g.addToCart({ items: [{ productId: UPC_MILK, quantity: 1 }, { productId: UPC_BREAD, quantity: 1 }] })).rejects.toThrow(/recent grocery search/);
    expect(api.adds).toEqual([]);
  });

  it("refuses an add when the search found nothing valid", async () => {
    const { api, g } = setup();
    api.data = [raw("bad", "x")];
    expect(await g.search({ query: "milk" })).toEqual([]);
    await expect(g.addToCart({ items: [{ productId: UPC_MILK, quantity: 1 }] })).rejects.toThrow(GroceryInputError);
    expect(api.adds).toEqual([]);
  });

  it("refuses over-cap carts before calling Kroger", async () => {
    const { api, g } = setup();
    await g.search({ query: "milk" });
    await expect(g.addToCart({ items: [{ productId: UPC_MILK, quantity: 11 }] })).rejects.toThrow(GroceryInputError);
    expect(api.adds).toEqual([]);
  });

  it("searched ids expire", async () => {
    let now = 1_000;
    const searched = new MemorySearchedProducts(60_000, () => now);
    await searched.remember([UPC_MILK]);
    expect(await searched.missing([UPC_MILK, UPC_EGGS])).toEqual([UPC_EGGS]);
    now += 60_000;
    expect(await searched.missing([UPC_MILK, UPC_EGGS])).toEqual([UPC_MILK, UPC_EGGS]);
  });

  it("uses DELIVERY when configured", async () => {
    const api = new FakeKroger();
    api.data = [raw(UPC_MILK, "Milk")];
    const g = new KrogerGrocery(api, new MemorySearchedProducts(), "DELIVERY");
    await g.search({ query: "milk" });
    await g.addToCart({ items: [{ productId: UPC_MILK, quantity: 1 }] });
    expect(api.adds[0]![0]!.modality).toBe("DELIVERY");
  });
});

describe("krogerHttpApi", () => {
  function fakeFetch(res: Response | (() => Promise<Response>)) {
    return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => (typeof res === "function" ? res() : res.clone()));
  }

  it("searches GET /v1/products with filters and the app token", async () => {
    const f = fakeFetch(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const api = krogerHttpApi({ userToken: async () => "user-tok", appToken: async () => "app-tok", fetch: f as unknown as typeof fetch });
    expect(await api.searchProducts({ term: "2% milk", locationId: "01400943", limit: 5 })).toEqual({ data: [] });
    const [url, init] = f.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe("https://api.kroger.com/v1/products");
    expect(u.searchParams.get("filter.term")).toBe("2% milk");
    expect(u.searchParams.get("filter.locationId")).toBe("01400943");
    expect(u.searchParams.get("filter.limit")).toBe("5");
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer app-tok");
    expect(init?.redirect).toBe("error");
  });

  it("falls back to the user token for search", async () => {
    const f = fakeFetch(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const api = krogerHttpApi({ userToken: async () => "user-tok", fetch: f as unknown as typeof fetch });
    await api.searchProducts({ term: "milk", limit: 1 });
    expect(new URL(String(f.mock.calls[0]![0])).searchParams.has("filter.locationId")).toBe(false);
    expect((f.mock.calls[0]![1]?.headers as Record<string, string>).Authorization).toBe("Bearer user-tok");
  });

  it("adds with PUT /v1/cart/add and the user token", async () => {
    const f = fakeFetch(new Response(null, { status: 204 }));
    const api = krogerHttpApi({ userToken: async () => "user-tok", appToken: async () => "app-tok", fetch: f as unknown as typeof fetch });
    await api.addToCart([{ upc: UPC_MILK, quantity: 2, modality: "PICKUP" }]);
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe("https://api.kroger.com/v1/cart/add");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ items: [{ upc: UPC_MILK, quantity: 2, modality: "PICKUP" }] });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer user-tok");
  });

  it("maps HTTP errors", async () => {
    const mk = (status: number) => krogerHttpApi({ userToken: async () => "t", fetch: fakeFetch(new Response("{}", { status })) as unknown as typeof fetch });
    await expect(mk(401).searchProducts({ term: "milk", limit: 1 })).rejects.toThrow(KrogerAuthError);
    await expect(mk(403).addToCart([{ upc: UPC_MILK, quantity: 1, modality: "PICKUP" }])).rejects.toThrow(KrogerAuthError);
    await expect(mk(429).searchProducts({ term: "milk", limit: 1 })).rejects.toThrow(KrogerRateLimitError);
    await expect(mk(500).searchProducts({ term: "milk", limit: 1 })).rejects.toThrow(KrogerUnavailableError);
    for (const status of [400, 404, 422]) {
      const add = mk(status).addToCart([{ upc: UPC_MILK, quantity: 1, modality: "PICKUP" }]);
      await expect(add).rejects.toThrow(KrogerCartRefusedError);
    }
    await expect(mk(400).addToCart([{ upc: UPC_MILK, quantity: 1, modality: "PICKUP" }])).rejects.toThrow(/refused the cart add \(HTTP 400\)\. Nothing was added/);
  });

  it("an app-token 401 on search blames the app credentials, not the owner's connection", async () => {
    const f = fakeFetch(new Response("{}", { status: 401 }));
    const app = krogerHttpApi({ userToken: async () => "u", appToken: async () => "a", fetch: f as unknown as typeof fetch });
    const e = await app.searchProducts({ term: "milk", limit: 1 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(KrogerAuthError);
    expect(e).toMatchObject({ appCredentials: true });
    expect((e as Error).message).toMatch(/misconfigured/);
    expect((e as Error).message).not.toMatch(/reconnect/);
    const user = krogerHttpApi({ userToken: async () => "u", fetch: f as unknown as typeof fetch });
    await expect(user.searchProducts({ term: "milk", limit: 1 })).rejects.toThrow(/reconnect Kroger/);
  });

  it("a search 400 is an input problem, not an outage", async () => {
    const api = krogerHttpApi({ userToken: async () => "t", fetch: fakeFetch(new Response("{}", { status: 400 })) as unknown as typeof fetch });
    await expect(api.searchProducts({ term: "milk", limit: 1 })).rejects.toThrow(GroceryInputError);
  });

  it("an add that may have applied is reported as uncertain, never as a clean failure", async () => {
    const line = [{ upc: UPC_MILK, quantity: 1, modality: "PICKUP" as const }];
    const timeout = krogerHttpApi({ userToken: async () => "t", fetch: (async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch });
    await expect(timeout.addToCart(line)).rejects.toThrow(KrogerCartUncertainError);
    await expect(timeout.addToCart(line)).rejects.toThrow(/timed out.*check the cart in the Kroger app/);
    const reset = krogerHttpApi({ userToken: async () => "t", fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    await expect(reset.addToCart(line)).rejects.toThrow(KrogerCartUncertainError);
    const s502 = krogerHttpApi({ userToken: async () => "t", fetch: fakeFetch(new Response("", { status: 502 })) as unknown as typeof fetch });
    await expect(s502.addToCart(line)).rejects.toThrow(/HTTP 502/);
    await expect(s502.addToCart(line)).rejects.toThrow(KrogerCartUncertainError);
    // A non-204 2xx is success.
    const ok200 = krogerHttpApi({ userToken: async () => "t", fetch: fakeFetch(new Response("{}", { status: 200 })) as unknown as typeof fetch });
    await expect(ok200.addToCart(line)).resolves.toBeUndefined();
  });

  it("a body that fails mid-read maps to KrogerUnavailableError", async () => {
    const res = new Response("{}", { status: 200 });
    Object.defineProperty(res, "text", { value: () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })) });
    const api = krogerHttpApi({ userToken: async () => "t", fetch: (async () => res) as unknown as typeof fetch });
    await expect(api.searchProducts({ term: "milk", limit: 1 })).rejects.toThrow(/timed out/);
    const big = new Response("{}", { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } });
    const api2 = krogerHttpApi({ userToken: async () => "t", fetch: (async () => big) as unknown as typeof fetch });
    await expect(api2.searchProducts({ term: "milk", limit: 1 })).rejects.toThrow(/too large/);
  });

  it("maps network failures, timeouts and junk bodies to KrogerUnavailableError", async () => {
    const boom = (e: Error) => krogerHttpApi({ userToken: async () => "t", fetch: (async () => { throw e; }) as unknown as typeof fetch });
    await expect(boom(new TypeError("fetch failed")).searchProducts({ term: "milk", limit: 1 })).rejects.toThrow(/network error/);
    await expect(boom(Object.assign(new Error("t"), { name: "TimeoutError" })).searchProducts({ term: "milk", limit: 1 })).rejects.toThrow(/timed out/);
    const junk = krogerHttpApi({ userToken: async () => "t", fetch: fakeFetch(new Response("<html>", { status: 200 })) as unknown as typeof fetch });
    await expect(junk.searchProducts({ term: "milk", limit: 1 })).rejects.toThrow(/unreadable/);
    const huge = krogerHttpApi({ userToken: async () => "t", fetch: fakeFetch(new Response("x".repeat(600 * 1024), { status: 200 })) as unknown as typeof fetch });
    await expect(huge.searchProducts({ term: "milk", limit: 1 })).rejects.toThrow(/too large/);
  });
});

describe("Kroger safety", () => {
  it("every Kroger request goes to product search or cart add, nothing else", async () => {
    const urls: string[] = [];
    const f = (async (u: string | URL | Request) => {
      urls.push(String(u));
      return String(u).includes("/products") ? new Response(JSON.stringify({ data: [raw(UPC_MILK, "Milk")] })) : new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const g = new KrogerGrocery(krogerHttpApi({ userToken: async () => "t", fetch: f }), new MemorySearchedProducts());
    await g.search({ query: "milk", locationId: "01400943" });
    await g.addToCart({ items: [{ productId: UPC_MILK, quantity: 1 }] });
    expect(urls.map((u) => new URL(u).origin + new URL(u).pathname)).toEqual(["https://api.kroger.com/v1/products", "https://api.kroger.com/v1/cart/add"]);
  });

  const ALLOWED_PATHS = ["/v1", "/products", "/cart/add", "/cart"];
  /** URL paths in code that aren't on the allowlist: at the start of a string (after an optional https://host) or after a `${...}`. */
  function disallowedPaths(code: string): string[] {
    const bad: string[] = [];
    for (const m of code.matchAll(/["'`](?:https:\/\/[^"'`]*?)?(\/[a-z][^"'`?]*)/gi)) {
      const p = m[1]!.replace(/\$\{[^}]*\}/g, "");
      if (!ALLOWED_PATHS.includes(p)) bad.push(m[0]);
    }
    for (const m of code.matchAll(/\$\{[^}]*\}(\/[^"'`?\s]*)/g)) {
      const p = m[1]!.replace(/\$\{[^}]*\}.*$/, "");
      if (!ALLOWED_PATHS.includes(p)) bad.push(m[0]);
    }
    return bad;
  }

  it("the path check catches paths after an interpolation and in plain strings", () => {
    expect(disallowedPaths("const u = `${base}/purchase`;")).toEqual(["${base}/purchase"]);
    expect(disallowedPaths('const u = "/v1/orders";')).toEqual(['"/v1/orders']);
    expect(disallowedPaths("const u = `${base}/${p}`;")).toHaveLength(1);
    expect(disallowedPaths("call(`${base}/products?${q}`); call(`${base}/cart/add`);")).toEqual([]);
  });

  it("no Kroger module names a checkout, order, payment or pickup-slot API path", () => {
    const dirs = ["../src/lib/kroger", "../src/lib/connectors/kroger"].map((d) => join(__dirname, d)).filter((d) => existsSync(d));
    const files = dirs.flatMap((d) => readdirSync(d).filter((n) => n.endsWith(".ts")).map((n) => join(d, n)));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      // The only URL paths allowed in code: the API base, the two endpoints, and the cart pages for hand-off.
      expect(disallowedPaths(code), file).toEqual([]);
      expect(code, file).not.toMatch(/\/(?:checkout|orders?|payments?|slots?|fulfillment)\b/i);
    }
  });

  it("checkout hand-off URLs are on the open_url allowlist", () => {
    for (const u of [krogerCartUrl(), krogerCartUrl("kingsoopers")]) {
      const url = new URL(u);
      expect(url.protocol).toBe("https:");
      expect(OPEN_URL_HOSTS).toContain(url.host);
    }
  });

  it("cleanText strips bidi/control characters and caps by code points", () => {
    expect(cleanText("a‮b\u0007c", 10)).toBe("a b c");
    expect(cleanText("😀😀😀", 2)).toBe("😀😀");
    expect(cleanText(42, 10)).toBe("");
  });
});
