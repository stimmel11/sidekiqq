import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { NextRequest } from "next/server";
import { SESSION_COOKIE, signSession } from "@/lib/dashboard/session";
import { middleware, config as middlewareConfig } from "@/middleware";
import { buildCsp, makeNonce, PERMISSIONS_POLICY } from "@/lib/pwa/headers";
import { GET as offlineGET } from "@/app/offline/route";
import manifest from "@/app/manifest";
import { MANIFEST_ICONS, APPLE_TOUCH_ICON } from "@/lib/pwa/icons";
import { DASHBOARD_METADATA as dashboardMetadata } from "@/lib/pwa/metadata";
import { GET as swGET } from "@/app/service-worker/route";
import { renderServiceWorker, swBuildId, swTemplate } from "@/lib/pwa/sw";

const BRAIN = path.resolve(__dirname, "..");
const REPO = path.resolve(BRAIN, "..");
const ORIGIN = "https://brain.example";
const SECRET = "test-session-secret-that-is-long-enough-1234";

// ----------------------------------------------------------------------------- service worker harness

type Listener = (ev: any) => void;

interface FakeResponse {
  status: number;
  type: string;
  headers: Headers;
  body: string;
  url: string;
  clone(): FakeResponse;
}

function res(body: string, init: { status?: number; headers?: Record<string, string>; type?: string } = {}): FakeResponse {
  const r: FakeResponse = {
    status: init.status ?? 200,
    type: init.type ?? "basic",
    headers: new Headers(init.headers ?? {}),
    body,
    url: "",
    clone: () => res(body, init),
  };
  return r;
}

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
  headers: Headers;
}

function loadServiceWorker(network: (url: string) => FakeResponse | Error) {
  const listeners: Record<string, Listener[]> = {};
  const stores = new Map<string, Map<string, FakeResponse>>();
  const puts: string[] = [];
  const fetched: string[] = [];
  const keyOf = (r: string | FakeRequest) => new URL(typeof r === "string" ? r : r.url, ORIGIN).toString();
  const openCache = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      put: async (r: string | FakeRequest, v: FakeResponse) => {
        puts.push(new URL(keyOf(r)).pathname);
        m.set(keyOf(r), v);
      },
      match: async (r: string | FakeRequest) => m.get(keyOf(r)),
    };
  };
  const caches = {
    open: async (name: string) => openCache(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (r: string | FakeRequest, opts?: { cacheName?: string }) => {
      const names = opts?.cacheName ? [opts.cacheName] : [...stores.keys()];
      for (const n of names) {
        const hit = stores.get(n)?.get(keyOf(r));
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const fetchImpl = async (r: string | FakeRequest) => {
    const url = keyOf(r);
    fetched.push(new URL(url).pathname + new URL(url).search);
    const out = network(url);
    if (out instanceof Error) throw out;
    return out;
  };
  class Request {
    url: string;
    method = "GET";
    mode = "cors";
    headers = new Headers();
    constructor(u: string) {
      this.url = new URL(u, ORIGIN).toString();
    }
  }
  class Response {
    status: number;
    body: string;
    type = "default";
    headers: Headers;
    constructor(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
      this.body = body;
      this.status = init.status ?? 200;
      this.headers = new Headers(init.headers ?? {});
    }
  }
  const self = {
    location: new URL(ORIGIN + "/service-worker"),
    addEventListener: (type: string, fn: Listener) => (listeners[type] ??= []).push(fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  const ctx = vm.createContext({ self, caches, fetch: fetchImpl, Request, Response, URL, Headers, Promise, console });
  vm.runInContext(renderServiceWorker("test"), ctx, { filename: "service-worker.js" });

  async function dispatchLifecycle(type: "install" | "activate") {
    let p: Promise<unknown> = Promise.resolve();
    for (const fn of listeners[type] ?? []) fn({ waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  }

  /** Returns the response the worker chose, or null when it left the request to the browser. */
  async function dispatchFetch(url: string, init: { method?: string; mode?: string; headers?: Record<string, string> } = {}): Promise<any> {
    const req: FakeRequest = {
      url: new URL(url, ORIGIN).toString(),
      method: init.method ?? "GET",
      mode: init.mode ?? "cors",
      headers: new Headers(init.headers ?? {}),
    };
    let responded: Promise<any> | null = null;
    for (const fn of listeners.fetch ?? []) fn({ request: req, respondWith: (x: Promise<any>) => (responded = x) });
    return responded ? await responded : null;
  }

  return { dispatchLifecycle, dispatchFetch, stores, puts, fetched };
}

const okNetwork = (url: string): FakeResponse | Error => {
  const p = new URL(url).pathname;
  if (p === "/offline") return res("<h1>You're offline.</h1>", { headers: { "cache-control": "public, max-age=0, must-revalidate" } });
  return res(`body of ${p}`);
};

describe("service worker build id", () => {
  it("puts the deploy id in the cache name so each deploy reinstalls the worker and drops the old cache", () => {
    expect(renderServiceWorker("abc123")).toContain('const CACHE = "sk-shell-abc123";');
    expect(renderServiceWorker("abc123")).not.toEqual(renderServiceWorker("def456"));
    expect(renderServiceWorker("x")).not.toContain("__SK_BUILD__");
    expect(swBuildId({ VERCEL_DEPLOYMENT_ID: "dpl_9Xy", VERCEL_GIT_COMMIT_SHA: "aaa" })).toBe("dpl_9Xy");
    expect(swBuildId({ VERCEL_GIT_COMMIT_SHA: "0f1e2d" })).toBe("0f1e2d");
    expect(swBuildId({})).toBe("local");
    expect(swBuildId({ SK_BUILD_ID: '"; alert(1); "' })).toBe("alert1");
    expect(() => renderServiceWorker('x";')).toThrow();
  });
});

describe("service worker: offline shell only", () => {
  it("precaches exactly the allowlist: /offline, the manifest and the icons", async () => {
    const sw = loadServiceWorker(okNetwork);
    await sw.dispatchLifecycle("install");
    expect([...sw.stores.keys()]).toEqual(["sk-shell-test"]);
    const cached = [...sw.stores.get("sk-shell-test")!.keys()].map((k) => new URL(k).pathname).sort();
    expect(cached).toEqual(
      ["/offline", "/manifest.webmanifest", ...MANIFEST_ICONS.map((i) => i.src), APPLE_TOUCH_ICON].sort(),
    );
    // Every precached file exists (icons are static files; the others are routes).
    for (const p of cached.filter((c) => c.startsWith("/icons/"))) expect(existsSync(path.join(BRAIN, "public", p))).toBe(true);
  });

  it("refuses to install when a precache response is not cacheable", async () => {
    const sw = loadServiceWorker((url) => (new URL(url).pathname === "/offline" ? res("x", { headers: { "cache-control": "no-store" } }) : res("ok")));
    await expect(sw.dispatchLifecycle("install")).rejects.toThrow(/precache refused \/offline/);
    const sw2 = loadServiceWorker((url) => (new URL(url).pathname === "/offline" ? res("x", { status: 500 }) : res("ok")));
    await expect(sw2.dispatchLifecycle("install")).rejects.toThrow(/precache refused/);
  });

  it("never handles /api/*, /auth/*, OAuth callbacks, RSC fetches or the manifest", async () => {
    const sw = loadServiceWorker(okNetwork);
    for (const url of [
      "/api/drafts",
      "/api/drafts/drf_1/approve",
      "/api/alerts?since=1",
      "/api/connections/google/callback?code=x&state=y",
      "/api/google/callback?code=x",
      "/auth/callback",
      "/manifest.webmanifest",
      "/icons/icon-192.png",
      "/offline",
      "/",
    ]) {
      expect(await sw.dispatchFetch(url), url).toBeNull();
      expect(await sw.dispatchFetch(url, { mode: "navigate" }), `navigate ${url}`).toBeNull();
    }
    // RSC fetches of dashboard pages carry personal data.
    expect(await sw.dispatchFetch("/dashboard/drafts?_rsc=abc")).toBeNull();
    expect(await sw.dispatchFetch("/dashboard/drafts", { headers: { RSC: "1" } })).toBeNull();
    expect(await sw.dispatchFetch("/dashboard/drafts?_rsc=abc", { mode: "navigate" })).toBeNull();
    // Cross-origin requests are left alone too.
    expect(await sw.dispatchFetch("https://fonts.googleapis.com/css2?family=Inter")).toBeNull();
    expect(sw.puts).toEqual([]);
  });

  it("never handles POSTs (server actions, approvals)", async () => {
    const sw = loadServiceWorker(okNetwork);
    expect(await sw.dispatchFetch("/dashboard/drafts/drf_1", { method: "POST", mode: "navigate" })).toBeNull();
    expect(await sw.dispatchFetch("/dashboard/drafts/drf_1", { method: "POST", headers: { "Next-Action": "abc" } })).toBeNull();
    expect(await sw.dispatchFetch("/api/drafts/drf_1/approve", { method: "POST" })).toBeNull();
    expect(await sw.dispatchFetch("/_next/static/chunks/x.js", { method: "POST" })).toBeNull();
    expect(sw.fetched).toEqual([]);
  });

  it("serves dashboard and /login navigations from the network and never caches them", async () => {
    const sw = loadServiceWorker(okNetwork);
    await sw.dispatchLifecycle("install");
    sw.puts.length = 0;
    for (const url of ["/dashboard", "/dashboard/drafts/drf_1", "/login?next=%2Fdashboard"]) {
      const r = await sw.dispatchFetch(url, { mode: "navigate" });
      expect(r.body).toBe(`body of ${new URL(url, ORIGIN).pathname}`);
    }
    expect(sw.puts).toEqual([]);
    // A second load goes to the network again (no cached copy of a page).
    const before = sw.fetched.length;
    await sw.dispatchFetch("/dashboard", { mode: "navigate" });
    expect(sw.fetched.length).toBe(before + 1);
    // Lookalike paths are not shell pages.
    expect(await sw.dispatchFetch("/dashboards", { mode: "navigate" })).toBeNull();
    expect(await sw.dispatchFetch("/login/extra", { mode: "navigate" })).toBeNull();
  });

  it("falls back to the precached /offline page when the network is down", async () => {
    let online = true;
    const sw = loadServiceWorker((url) => (online ? okNetwork(url) : new TypeError("Failed to fetch")));
    await sw.dispatchLifecycle("install");
    online = false;
    const r = await sw.dispatchFetch("/dashboard/drafts", { mode: "navigate" });
    expect(r.status).toBe(200);
    expect(r.body).toContain("offline");
  });

  it("answers 503 text when offline and /offline was never cached", async () => {
    const sw = loadServiceWorker(() => new TypeError("Failed to fetch"));
    const r = await sw.dispatchFetch("/dashboard", { mode: "navigate" });
    expect(r.status).toBe(503);
    expect(r.body).toMatch(/offline/i);
  });

  it("caches /_next/static/* cache-first, but only clean 200 responses", async () => {
    const responses: Record<string, FakeResponse> = {
      "/_next/static/chunks/app.js": res("js"),
      "/_next/static/css/a.css": res("css", { headers: { "cache-control": "no-store" } }),
      "/_next/static/chunks/err.js": res("nope", { status: 404 }),
      "/_next/static/chunks/opaque.js": res("o", { type: "opaque" }),
    };
    const sw = loadServiceWorker((url) => responses[new URL(url).pathname] ?? res("x"));
    for (const p of Object.keys(responses)) await sw.dispatchFetch(p);
    expect(sw.puts).toEqual(["/_next/static/chunks/app.js"]);
    // Second hit is served from the cache, no network.
    const n = sw.fetched.length;
    const again = await sw.dispatchFetch("/_next/static/chunks/app.js");
    expect(again.body).toBe("js");
    expect(sw.fetched.length).toBe(n);
  });

  it("activate deletes only older sk-shell caches", async () => {
    const sw = loadServiceWorker(okNetwork);
    sw.stores.set("sk-shell-v0", new Map());
    sw.stores.set("other-cache", new Map());
    await sw.dispatchLifecycle("install");
    await sw.dispatchLifecycle("activate");
    expect([...sw.stores.keys()].sort()).toEqual(["other-cache", "sk-shell-test"]);
  });

  it("the worker source has no background sync, push or message handlers", () => {
    const src = swTemplate();
    expect(src).not.toMatch(/addEventListener\(\s*["'](sync|periodicsync|push|message|notificationclick)["']/);
    expect(src).not.toMatch(/approve/);
  });
});

// ----------------------------------------------------------------------------- headers

describe("app shell security headers", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  function req(p: string, cookie?: string, extra: Record<string, string> = {}) {
    const headers = new Headers(extra);
    if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`);
    return new NextRequest(new URL(p, ORIGIN), { headers });
  }

  it("builds a nonce CSP with no third-party scripts", () => {
    const n = makeNonce();
    expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(makeNonce()).not.toBe(n);
    const csp = buildCsp(n);
    expect(csp).toContain(`script-src 'self' 'nonce-${n}' 'strict-dynamic'`);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(scriptSrc).not.toMatch(/https?:/);
    expect(buildCsp(n, { dev: true })).toContain("'unsafe-eval'");
    expect(() => buildCsp("bad nonce'; script-src *")).toThrow();
  });

  it("dashboard pages get CSP (forwarded to Next.js with the nonce), Permissions-Policy and nosniff", async () => {
    const t = await signSession(SECRET);
    const res = await middleware(req("/dashboard/drafts", t.value));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    const csp = res.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    expect(res.headers.get("permissions-policy")).toBe(PERMISSIONS_POLICY);
    expect(PERMISSIONS_POLICY).toBe("microphone=(self), camera=(), geolocation=()");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    // A fresh nonce every request.
    const res2 = await middleware(req("/dashboard/drafts", t.value));
    expect(res2.headers.get("x-middleware-request-x-nonce")).not.toBe(nonce);
  });

  it("a client-supplied nonce header is overwritten", async () => {
    const t = await signSession(SECRET);
    const res = await middleware(req("/dashboard", t.value, { "x-nonce": "AAAAAAAAAAAAAAAAAAAAAA==" }));
    expect(res.headers.get("x-middleware-request-x-nonce")).not.toBe("AAAAAAAAAAAAAAAAAAAAAA==");
  });

  it("/login gets the same shell headers without a session; unauthenticated dashboard still redirects", async () => {
    expect(middlewareConfig.matcher).toContain("/login");
    const res = await middleware(req("/login?next=%2Fdashboard"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("content-security-policy")).toMatch(/'nonce-[^']+' 'strict-dynamic'/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect((await middleware(req("/dashboard"))).status).toBe(303);
  });

  it("API replies are marked no-store, including 401s and public routes", async () => {
    const authed = await middleware(req("/api/drafts", undefined, { authorization: "Bearer tok" }));
    expect(authed.headers.get("x-middleware-next")).toBe("1");
    expect(authed.headers.get("cache-control")).toBe("no-store");
    const denied = await middleware(req("/api/drafts"));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect((await middleware(req("/api/health"))).headers.get("cache-control")).toBe("no-store");
    // API routes don't get the page CSP (they aren't documents).
    expect(authed.headers.get("content-security-policy")).toBeNull();
  });

  it("/service-worker is always revalidated and may control the whole origin", async () => {
    const r = swGET();
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(r.headers.get("service-worker-allowed")).toBe("/");
    expect(r.headers.get("content-type")).toMatch(/javascript/);
    expect(await r.text()).toMatch(/const CACHE = "sk-shell-[A-Za-z0-9_-]+";/);
  });
});

// ----------------------------------------------------------------------------- offline page

describe("GET /offline", () => {
  it("is static, cacheable by the worker, and carries no scripts or personal data", async () => {
    const r = offlineGET();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("cache-control")).not.toMatch(/no-store/);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await r.text();
    expect(html).toContain("You're offline.");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//); // no external fetches, so it renders with no network
    expect(html).not.toMatch(/<img|<link/i);
  });
});

// ----------------------------------------------------------------------------- manifest + icons

function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("manifest and icons", () => {
  it("installs as a standalone app starting at the dashboard", () => {
    const m = manifest();
    expect(m.start_url).toBe("/dashboard");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.name).toBe("SideKiqq");
    const tokens = JSON.parse(readFileSync(path.join(REPO, "design/tokens.json"), "utf8"));
    expect(m.theme_color).toBe(tokens.brand.ink);
    expect(m.background_color).toBe(tokens.brand.ink);
    expect(m.icons!.map((i) => i.purpose)).toEqual(["any", "any", "maskable"]);
  });

  it("every icon exists at its declared size", () => {
    for (const i of MANIFEST_ICONS) {
      const [w, h] = pngSize(path.join(BRAIN, "public", i.src));
      expect(`${w}x${h}`).toBe(i.sizes);
    }
    expect(pngSize(path.join(BRAIN, "public", APPLE_TOUCH_ICON))).toEqual([180, 180]);
  });

  it("the dashboard layout links the manifest and the Home Screen metadata", () => {
    expect(dashboardMetadata.manifest).toBe("/manifest.webmanifest");
    expect(dashboardMetadata.appleWebApp).toMatchObject({ capable: true, title: "SideKiqq" });
  });

  it("committed icons match design/icons.mjs output pixel for pixel (run `node design/icons.mjs`)", async () => {
    // @ts-expect-error plain .mjs script without types
    const { buildIcons, samePixels, OUTPUTS } = await import("../../design/icons.mjs");
    const icons = buildIcons() as { file: string; data: Buffer }[];
    expect(icons.map((i) => i.file).sort()).toEqual(Object.keys(OUTPUTS).sort());
    for (const icon of icons) {
      for (const dir of OUTPUTS[icon.file] as string[]) {
        expect(samePixels(readFileSync(path.join(REPO, dir, icon.file)), icon.data), `${dir}/${icon.file}`).toBe(true);
      }
    }
  });

  it("favicon.ico has 16/32/48 entries, a rounded tile and the mark drawn in it", async () => {
    // @ts-expect-error plain .mjs script without types
    const { decodeIco, decodePng, TILE } = await import("../../design/icons.mjs");
    const entries = decodeIco(readFileSync(path.join(BRAIN, "src/app/favicon.ico"))) as { size: number; png: Buffer }[];
    expect(entries.map((e) => e.size)).toEqual([16, 32, 48]);
    for (const { size, png } of entries) {
      const { width, channels, data } = decodePng(png) as { width: number; channels: number; data: Buffer };
      expect([width, channels]).toEqual([size, 4]);
      expect(data[3]).toBe(0); // transparent corner (rounded tile)
      const center = ((size >> 1) * size + (size >> 1)) * 4;
      expect(data[center + 3]).toBe(255);
      // Some pixels are clearly line-coloured, so the mark survives at this size.
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 255 && data[i]! < (TILE.bg[0] + TILE.fg[0]) / 2) dark++;
      expect(dark).toBeGreaterThan(size);
    }
  });

  it("the icon generator refuses PNG sources it can't read", async () => {
    // @ts-expect-error plain .mjs script without types
    const { decodePng, loadMask, MARK } = await import("../../design/icons.mjs");
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(/not a PNG/);
    const mark = decodePng(readFileSync(MARK)) as { width: number; height: number };
    expect([mark.width, mark.height]).toEqual([1024, 1024]);
    expect(() => loadMask(readFileSync(path.join(BRAIN, "public/icons/apple-touch-icon.png")).subarray(0, 40))).toThrow();
  });
});
