import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { resolveTarget } from "@/lib/commands";
import { checkNumber, checkOpenUrl, handoffLink } from "@/lib/commands/links";
import { handoffCapability } from "@/lib/connectors/handoff";
import { SESSION_COOKIE, signSession } from "@/lib/dashboard/session";
import { dashboardDeviceToken } from "@/lib/dashboard/web-device";
import { ackHandoff, fetchHandoffs, mergeHandoffs } from "@/lib/handoffs/browser-api";
import type { DeviceRecord } from "@/lib/models";
import { middleware } from "@/middleware";
import { GET as listCommands, POST as createCommand } from "@/app/api/commands/route";
import { POST as ackCommand } from "@/app/api/commands/[id]/ack/route";
import { makeDeps, NO_PARAMS, pairDevice, params, req, type TestDeps } from "./fakes";

/**
 * Web app slice 4 (docs/WEBAPP.md §7): call and link hand-offs can wait in the owner's browser.
 * The browser reads GET /api/commands and acks as the session, re-checks every field before it
 * builds a link, builds links only from structured fields, and never opens anything by itself.
 */

const SESSION_SECRET = "test-session-secret-0123456789abcdef";
const KEY = randomBytes(32);
const SAME = { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" };

beforeEach(() => {
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.TOKEN_ENCRYPTION_KEY = KEY.toString("base64");
});
afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

async function cookie(): Promise<string> {
  return `${SESSION_COOKIE}=${(await signSession(SESSION_SECRET)).value}`;
}

async function webDevice(deps: TestDeps): Promise<DeviceRecord> {
  const token = await dashboardDeviceToken(deps, KEY);
  return (await deps.repos.devices.findByToken(token))!;
}

describe("handoffLink (browser re-check, WEBAPP.md §7)", () => {
  it("builds tel:, wa.me and https links from the structured fields", () => {
    expect(handoffLink({ kind: "call_contact", number: "+13035550142", app: "phone" })).toEqual({
      ok: true, href: "tel:+13035550142", detail: "+13035550142", external: false, action: "Call",
    });
    expect(handoffLink({ kind: "call_contact", number: "3035550142" })).toMatchObject({ ok: true, href: "tel:3035550142" });
    expect(handoffLink({ kind: "call_contact", number: "+44 20 7946 0958", app: "whatsapp" })).toMatchObject({ ok: true, href: "https://wa.me/442079460958", external: true });
    expect(handoffLink({ kind: "open_url", url: "https://us02web.zoom.us/j/123?pwd=x" })).toMatchObject({ ok: true, href: "https://us02web.zoom.us/j/123?pwd=x", detail: "us02web.zoom.us", external: true, action: "Open" });
    expect(handoffLink({ kind: "open_url", url: "https://meet.google.com/abc-defg-hij" })).toMatchObject({ ok: true, detail: "meet.google.com" });
  });

  it("rejects bad numbers: dialer codes, post-dial digits, wrong length, WhatsApp without +", () => {
    for (const n of ["*21#", "303*555", "303#", "303,1234", "303;1234", "12", "1234567890123456", "", "tel:3035550142", "+1 303 555 0142 ext 2", "٣٠٣٥٥٥٠١٤٢", undefined]) {
      expect(checkNumber(n), String(n)).toBeNull();
      expect(handoffLink({ kind: "call_contact", number: n }).ok, String(n)).toBe(false);
    }
    expect(handoffLink({ kind: "call_contact", number: "3035550142", app: "whatsapp" }).ok).toBe(false);
    expect(handoffLink({ kind: "call_contact", number: "3035550142", app: "signal" }).ok).toBe(false);
  });

  it("rejects bad links: not https, credentials, port, off-allowlist or look-alike hosts", () => {
    for (const u of [
      "http://zoom.us/j/1",
      "javascript:alert(1)",
      "https://user:pw@zoom.us/j/1",
      "https://zoom.us:8443/j/1",
      "https://evil.example/j/1",
      "https://zoom.us.evil.example/j/1",
      "https://evilzoom.us/j/1",
      "https://kroger.com/cart",
      "//zoom.us/j/1",
      "zoom.us/j/1",
      undefined,
    ]) {
      expect(checkOpenUrl(u), String(u)).toBeNull();
      expect(handoffLink({ kind: "open_url", url: u }).ok, String(u)).toBe(false);
    }
  });

  it("never builds a link from the label, and only call/link kinds run in a browser", () => {
    const fromLabel = handoffLink({ kind: "open_url", label: "https://zoom.us/j/1" } as never);
    expect(fromLabel.ok).toBe(false);
    for (const kind of ["reachy_wake", "reachy_start", "something_new"]) {
      expect(handoffLink({ kind, url: "https://zoom.us/j/1", number: "3035550142" }).ok, kind).toBe(false);
    }
  });
});

describe("resolveTarget: phone first, then a signed-in browser", () => {
  const dev = (id: string, kind: DeviceRecord["kind"], lastSeenAt: string, revoked = false): DeviceRecord =>
    ({ id, kind, name: id, createdAt: "2026-11-01T00:00:00.000Z", lastSeenAt, revoked }) as DeviceRecord;

  it("prefers any live phone over a more recently seen browser, and falls back to the newest browser", () => {
    const web1 = dev("w1", "web", "2026-11-20T10:00:00.000Z");
    const web2 = dev("w2", "web", "2026-11-20T11:00:00.000Z");
    const phone = dev("p1", "phone", "2026-11-01T00:00:00.000Z");
    expect(resolveTarget("call_contact", undefined, [web1, web2, phone]).id).toBe("p1");
    expect(resolveTarget("open_url", undefined, [web1, web2, phone]).id).toBe("p1");
    expect(resolveTarget("call_contact", undefined, [web1, web2, { ...phone, revoked: true }]).id).toBe("w2");
    expect(resolveTarget("open_url", undefined, [web1, web2]).id).toBe("w2");
    expect(() => resolveTarget("call_contact", undefined, [{ ...web1, revoked: true }])).toThrow(/no paired phone/);
  });

  it("keeps reachy_start on the phone and reachy_wake on Reachy", () => {
    const web = dev("w1", "web", "2026-11-20T10:00:00.000Z");
    expect(() => resolveTarget("reachy_start", undefined, [web])).toThrow(/no paired phone/);
    expect(() => resolveTarget("reachy_start", { device: "web" }, [web])).toThrow(/can't run/);
    expect(() => resolveTarget("reachy_start", { deviceId: "w1" }, [web])).toThrow(/can't run/);
    expect(() => resolveTarget("reachy_wake", undefined, [web])).toThrow(/no paired reachy/);
  });
});

describe("GET /api/commands and ack as the dashboard session", () => {
  async function world() {
    const deps = makeDeps();
    setDeps(deps);
    const web = await webDevice(deps);
    const watch = await pairDevice(deps, "watch");
    const create = async (body: unknown) => {
      const r = await createCommand(req("POST", "/api/commands", { token: watch.token, body }), NO_PARAMS);
      expect(r.status).toBe(201);
      return ((await r.json()) as { command: { id: string }; device: string });
    };
    return { deps, web, watch, create };
  }

  it("lists the web device's hand-offs and acks them as the session", async () => {
    const w = await world();
    const call = await w.create({ kind: "call_contact", number: "303 555 0142", name: "Dana" });
    expect(call.device).toBe("web");
    const c = await cookie();
    const list = await listCommands(req("GET", "/api/commands", { headers: { cookie: c } }), NO_PARAMS);
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const { items } = (await list.json()) as { items: { id: string; label: string; number: string }[] };
    expect(items).toEqual([expect.objectContaining({ id: call.command.id, label: "Call Dana (3035550142)", number: "3035550142" })]);

    const ack = await ackCommand(req("POST", `/api/commands/${call.command.id}/ack`, { headers: { cookie: c, ...SAME }, body: { result: "opened" } }), params({ id: call.command.id }));
    expect(ack.status).toBe(200);
    expect((await w.deps.repos.commands.get(call.command.id))!.status).toBe("opened");
    const after = await listCommands(req("GET", "/api/commands", { headers: { cookie: c } }), NO_PARAMS);
    expect(((await after.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("refuses a cross-site or header-less ack (fail-closed CSRF) and leaves the command pending", async () => {
    const w = await world();
    const { command } = await w.create({ kind: "open_url", url: "https://zoom.us/j/1" });
    const c = await cookie();
    const bad: Record<string, string>[] = [{}, { "sec-fetch-site": "cross-site" }, { origin: "https://evil.example" }, { origin: "null" }];
    for (const h of bad) {
      const r = await ackCommand(req("POST", `/api/commands/${command.id}/ack`, { headers: { cookie: c, ...h }, body: { result: "dismissed" } }), params({ id: command.id }));
      expect(r.status, JSON.stringify(h)).toBe(403);
    }
    expect((await w.deps.repos.commands.get(command.id))!.status).toBe("pending");
  });

  it("a session can't see or ack the phone's hand-offs", async () => {
    const w = await world();
    const phone = await pairDevice(w.deps, "phone");
    const { command, device } = await w.create({ kind: "call_contact", number: "303 555 0142" });
    expect(device).toBe("phone");
    const c = await cookie();
    const list = await listCommands(req("GET", "/api/commands", { headers: { cookie: c } }), NO_PARAMS);
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
    const ack = await ackCommand(req("POST", `/api/commands/${command.id}/ack`, { headers: { cookie: c, ...SAME }, body: { result: "dismissed" } }), params({ id: command.id }));
    expect(ack.status).toBe(404);
    expect((await w.deps.repos.commands.pendingFor(phone.device.id))).toHaveLength(1);
  });

  it("POST /api/commands still needs a device token: the cookie alone is 401", async () => {
    const w = await world();
    const r = await createCommand(req("POST", "/api/commands", { headers: { cookie: await cookie(), ...SAME }, body: { kind: "call_contact", number: "3035550142" } }), NO_PARAMS);
    expect(r.status).toBe(401);
    expect(await w.deps.repos.commands.pendingFor(w.web.id)).toEqual([]);
  });

  it("no session and no token is 401", async () => {
    await world();
    expect((await listCommands(req("GET", "/api/commands"), NO_PARAMS)).status).toBe(401);
  });

  it("middleware lets the cookie reach GET /api/commands and the ack, nothing near them", async () => {
    const value = (await signSession(SESSION_SECRET)).value;
    const mk = (path: string, method = "POST", withCookie = true) => {
      const headers = new Headers();
      if (withCookie) headers.set("cookie", `${SESSION_COOKIE}=${value}`);
      return new NextRequest(new URL(path, "https://brain.example"), { method, headers });
    };
    const passes = async (r: NextRequest) => (await middleware(r)).headers.get("x-middleware-next") === "1";
    expect(await passes(mk("/api/commands", "GET"))).toBe(true);
    expect(await passes(mk("/api/commands/cmd_abc123/ack"))).toBe(true);
    expect((await middleware(mk("/api/commands", "GET", false))).status).toBe(401);
    for (const p of ["/api/commands/cmd_abc123", "/api/commands/a.b/ack", "/api/commands/cmd_1/ack/x", "/api/commandsx"]) {
      expect((await middleware(mk(p))).status, p).toBe(401);
    }
  });
});

describe("assistant hand-offs fall back to the browser when no phone is paired", () => {
  it("handoffCapability reports the target kind, so the tool tells the owner where to tap", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const web = await webDevice(deps);
    const watch = await pairDevice(deps, "watch");
    const join = "https://zoom.us/j/123";
    const r = await handoffCapability(deps, "device.open_url", { url: join }, {
      caller: "ask",
      device: "watch",
      origin: { deviceId: watch.device.id, deviceKind: "watch" },
      allowedUrls: new Set([join]),
    });
    expect(r).toMatchObject({ queued: true, device: "web", url: join });
    expect(await deps.repos.commands.pendingFor(web.id)).toHaveLength(1);
  });

  it("the tool notes name the browser when that's where it waits", () => {
    const src = readFileSync(join(__dirname, "../src/lib/assistant/tools.ts"), "utf8");
    expect(src).toContain("waitingOn(target.kind, \"Call\")");
    expect(src).toContain("waitingOn(r.device, \"Open\")");
  });
});

describe("browser client (lib/handoffs/browser-api.ts)", () => {
  it("drops malformed rows and keeps only the fields a card uses", async () => {
    const rows = [
      { id: "cmd_1", kind: "call_contact", label: "Call Dana", expiresAt: "2026-11-20T10:15:00.000Z", number: "3035550142", extra: "x" },
      { id: "../x", kind: "open_url", label: "bad id", expiresAt: "x" },
      { id: "cmd_2", kind: "open_url", label: 5, expiresAt: "x" },
      null,
    ];
    const calls: [string, RequestInit | undefined][] = [];
    const fake = async (u: string, i?: RequestInit) => (calls.push([u, i]), new Response(JSON.stringify({ items: rows }), { status: 200 }));
    const r = await fetchHandoffs(fake);
    expect(r).toEqual({ ok: true, items: [{ id: "cmd_1", kind: "call_contact", label: "Call Dana", expiresAt: "2026-11-20T10:15:00.000Z", number: "3035550142" }] });
    expect(calls[0]![0]).toBe("/api/commands?limit=20");
    expect(calls[0]![1]).toMatchObject({ method: "GET", credentials: "same-origin" });
    expect(await fetchHandoffs(async () => new Response("{}", { status: 401 }))).toEqual({ ok: false, status: 401 });
    expect(await fetchHandoffs(async () => { throw new Error("offline"); })).toEqual({ ok: false, status: 0 });
  });

  it("acks with a same-origin keepalive POST, and refuses odd ids without a request", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fake = async (u: string, i?: RequestInit) => (calls.push([u, i]), new Response("{}", { status: 200 }));
    expect(await ackHandoff("cmd_1", "opened", fake)).toBe(true);
    expect(calls[0]![0]).toBe("/api/commands/cmd_1/ack");
    expect(calls[0]![1]).toMatchObject({ method: "POST", credentials: "same-origin", keepalive: true, body: JSON.stringify({ result: "opened" }) });
    expect(calls[0]![1]!.headers).not.toHaveProperty("authorization");
    for (const id of ["../drafts/x/approve", "a/b", "", "x".repeat(65)]) expect(await ackHandoff(id, "dismissed", fake)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(await ackHandoff("cmd_1", "opened", async () => { throw new Error("offline"); })).toBe(false);
  });

  it("HandoffCards never opens anything by itself and builds links only via handoffLink", () => {
    const src = readFileSync(join(__dirname, "../src/components/handoffs/HandoffCards.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const bad of [/window\.open/, /location\s*(\.\w+\s*)?=/, /location\.(assign|replace)/, /\.click\(\)/, /dispatchEvent/, /c\.label[^}]*href/, /\bhref=\{c\./]) {
      expect(code, String(bad)).not.toMatch(bad);
    }
    expect(code).toMatch(/href=\{link\.href\}/);
    expect(code).toMatch(/rel: "noopener noreferrer"/);
    // The card shows the label as text only.
    expect(code).not.toMatch(/dangerouslySetInnerHTML/);
  });
});

describe("mergeHandoffs (card list after a poll)", () => {
  const item = (id: string, expiresAt = "2026-11-20T10:15:00.000Z") => ({ id, kind: "call_contact", label: id, expiresAt });
  const NOW = Date.parse("2026-11-20T10:00:00.000Z");

  it("drops acted-on cards and follows the server's list, not the local clock", () => {
    const server = [item("a"), item("b", "2026-11-20T09:00:00.000Z")];
    // "b" looks expired to this clock but the server still lists it: still shown.
    expect(mergeHandoffs([], server, new Set(["a"]), new Set(), NOW).map((c) => c.id)).toEqual(["b"]);
    expect(mergeHandoffs([item("x")], [], new Set(), new Set(), NOW)).toEqual([]);
  });

  it("keeps a failed card until it's dismissed or expired, even once the server drops it", () => {
    const failed = new Set(["f"]);
    expect(mergeHandoffs([item("f")], [], new Set(), failed, NOW).map((c) => c.id)).toEqual(["f"]);
    expect(mergeHandoffs([item("f")], [], new Set(["f"]), failed, NOW)).toEqual([]);
    expect(mergeHandoffs([item("f", "2026-11-20T09:59:00.000Z")], [], new Set(), failed, NOW)).toEqual([]);
    // No duplicate while the server still lists it.
    expect(mergeHandoffs([item("f")], [item("f")], new Set(), failed, NOW)).toHaveLength(1);
  });
});
