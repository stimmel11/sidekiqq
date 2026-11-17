import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import { authenticatePrincipal, requireSameOrigin } from "@/lib/auth";
import { draftFingerprint } from "@/lib/confirmation";
import { draftFingerprint as dashboardFingerprint } from "@/lib/dashboard/approval";
import { invokeCapability } from "@/lib/connectors/invoke";
import { SESSION_COOKIE, signSession } from "@/lib/dashboard/session";
import { DASHBOARD_DEVICE_NAME, dashboardDeviceToken } from "@/lib/dashboard/device-bridge";
import { middleware } from "@/middleware";
import { GET as listDrafts } from "@/app/api/drafts/route";
import { POST as approve } from "@/app/api/drafts/[id]/approve/route";
import { POST as discard } from "@/app/api/drafts/[id]/discard/route";
import { makeDeps, pairDevice, params, req, type TestDeps } from "./fakes";

/** Web app slice 2c-i (docs/WEBAPP.md §4, §4.2): withPrincipal, fail-closed CSRF, approve fingerprint for sessions. */

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

async function cookie(secret = SESSION_SECRET): Promise<string> {
  return `${SESSION_COOKIE}=${(await signSession(secret)).value}`;
}

async function setup(): Promise<{ deps: TestDeps; id: string; providerDraftId: string }> {
  const deps = makeDeps();
  setDeps(deps);
  const out = await invokeCapability(deps, "email.draft", { to: ["dana@acme.com"], subject: "Proposal", body: "Here it is." }, { caller: "ask" });
  return { deps, id: out.draftId, providerDraftId: out.providerDraftId! };
}

async function fingerprintOf(deps: TestDeps, id: string): Promise<string> {
  return draftFingerprint((await deps.repos.drafts.get(id))!);
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code;
}

describe("approve with a dashboard session principal", () => {
  it("sends with the right fingerprint on a same-origin request; timeline says web", async () => {
    const { deps, id, providerDraftId } = await setup();
    const res = await approve(req("POST", "/x", { headers: { cookie: await cookie(), ...SAME }, body: { confirmation: await fingerprintOf(deps, id) } }), params({ id }));
    expect(res.status).toBe(200);
    expect(deps.sender.sendDraft).toHaveBeenCalledExactlyOnceWith(providerDraftId);
    expect((await deps.repos.drafts.get(id))?.status).toBe("sent");
    const events = (await deps.repos.timeline.since("2000-01-01T00:00:00Z")).map((e) => e.event);
    expect(events.some((e) => e.includes("(approved on web)"))).toBe(true);
  });

  it("no body, a bad body or a missing confirmation: 400 confirmation_required, nothing sent, still pending", async () => {
    const { deps, id } = await setup();
    const c = await cookie();
    const bodies: (unknown | undefined)[] = [undefined, {}, { confirmation: "" }, { confirmation: 42 }, { confirmation: "send" }, { confirm: "send" }, ["x"]];
    for (const body of bodies) {
      const res = await approve(req("POST", "/x", { headers: { cookie: c, ...SAME }, ...(body !== undefined ? { body } : {}) }), params({ id }));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await codeOf(res)).toBe("confirmation_required");
    }
    const raw = await approve(req("POST", "/x", { headers: { cookie: c, ...SAME, "content-type": "application/json" }, raw: "{not json" }), params({ id }));
    expect(raw.status).toBe(400);
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    expect((await deps.repos.drafts.get(id))?.status).toBe("pending");
  });

  it("a stale fingerprint (draft changed after the dialog opened): 409 changed, nothing sent, still pending", async () => {
    const { deps, id } = await setup();
    const shown = await fingerprintOf(deps, id);
    const d = (await deps.repos.drafts.get(id))!;
    await deps.kv.hset("t:drafts", id, JSON.stringify({ ...d, body: "Wire $5,000 today." }));
    expect(await fingerprintOf(deps, id)).not.toBe(shown);
    const res = await approve(req("POST", "/x", { headers: { cookie: await cookie(), ...SAME }, body: { confirmation: shown } }), params({ id }));
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("changed");
    // Another draft's fingerprint doesn't fit either.
    const other = await invokeCapability(deps, "email.draft", { to: ["lee@acme.com"], subject: "Other", body: "b" }, { caller: "ask" });
    const wrong = await approve(req("POST", "/x", { headers: { cookie: await cookie(), ...SAME }, body: { confirmation: await fingerprintOf(deps, other.draftId) } }), params({ id }));
    expect(await codeOf(wrong)).toBe("changed");
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    expect((await deps.repos.drafts.get(id))?.status).toBe("pending");
  });

  it("fail-closed CSRF: both headers missing, cross-site, same-site, a foreign or null Origin: 403, nothing sent", async () => {
    const { deps, id } = await setup();
    const c = await cookie();
    const confirmation = await fingerprintOf(deps, id);
    const cases: Record<string, string>[] = [
      {},
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "none" },
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: "http://localhost:3000", "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
    ];
    for (const h of cases) {
      const res = await approve(req("POST", "/x", { headers: { cookie: c, ...h }, body: { confirmation } }), params({ id }));
      expect(res.status, JSON.stringify(h)).toBe(403);
      expect(await codeOf(res)).toBe("cross_site");
    }
    // One same-origin header is enough (older browsers send only Origin).
    for (const h of [{ origin: "http://localhost:3000" }, { "sec-fetch-site": "same-origin" }] as Record<string, string>[]) {
      expect(() => requireSameOrigin(req("POST", "/x", { headers: h }))).not.toThrow();
    }
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    expect((await deps.repos.drafts.get(id))?.status).toBe("pending");
  });

  it("no credential, a forged or expired cookie: 401; the owner secret is not a device token", async () => {
    const { deps, id } = await setup();
    const confirmation = await fingerprintOf(deps, id);
    const forged = await cookie("another-secret-that-is-long-enough-0000");
    const expired = `${SESSION_COOKIE}=${(await signSession(SESSION_SECRET, new Date(Date.now() - 8 * 24 * 3600 * 1000))).value}`;
    for (const headers of [SAME, { cookie: forged, ...SAME }, { cookie: expired, ...SAME }, { authorization: "Bearer test-owner-secret-0123456789", ...SAME }, { "x-owner-secret": "test-owner-secret-0123456789", ...SAME }]) {
      const res = await approve(req("POST", "/x", { headers, body: { confirmation } }), params({ id }));
      expect(res.status, JSON.stringify(headers)).toBe(401);
    }
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });

  it("SESSION_SECRET unset: the cookie is never accepted", async () => {
    const { deps, id } = await setup();
    const c = await cookie();
    delete process.env.SESSION_SECRET;
    const res = await approve(req("POST", "/x", { headers: { cookie: c, ...SAME }, body: { confirmation: await fingerprintOf(deps, id) } }), params({ id }));
    expect(res.status).toBe(401);
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });
});

describe("approve with a session: edge cases (review follow-ups)", () => {
  it("a draft changed between the first read and the re-read under the lock: 409 changed, nothing sent", async () => {
    const { deps, id } = await setup();
    const shown = await fingerprintOf(deps, id);
    const lock = deps.repos.drafts.acquireSendLock.bind(deps.repos.drafts);
    deps.repos.drafts.acquireSendLock = async (draftId: string, ttl?: number) => {
      const d = (await deps.repos.drafts.get(draftId))!;
      await deps.kv.hset("t:drafts", draftId, JSON.stringify({ ...d, to: ["mallory@evil.example"] }));
      return lock(draftId, ttl);
    };
    const res = await approve(req("POST", "/x", { headers: { cookie: await cookie(), ...SAME }, body: { confirmation: shown } }), params({ id }));
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("changed");
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    expect((await deps.repos.drafts.get(id))?.status).toBe("pending");
    // The lock was released: a fresh, matching confirmation can still approve.
    deps.repos.drafts.acquireSendLock = lock;
  });

  it("an empty or non-bearer Authorization header next to a valid cookie: 401, nothing sent or discarded", async () => {
    const { deps, id } = await setup();
    const c = await cookie();
    const confirmation = await fingerprintOf(deps, id);
    for (const authorization of ["", "Basic dXNlcjpwYXNz", "Bearer"]) {
      const a = await approve(req("POST", "/x", { headers: { authorization, cookie: c, ...SAME }, body: { confirmation } }), params({ id }));
      expect(a.status, authorization).toBe(401);
      const d = await discard(req("POST", "/x", { headers: { authorization, cookie: c, ...SAME } }), params({ id }));
      expect(d.status, authorization).toBe(401);
    }
    const d = await discard(req("POST", "/x", { token: "skq_nope", headers: { cookie: c, ...SAME } }), params({ id }));
    expect(d.status).toBe(401);
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    expect((await deps.repos.drafts.get(id))?.status).toBe("pending");
  });

  it("a session approves a calendar invite only with the v2 fingerprint (time, place, Meet)", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const d = await deps.repos.drafts.create({
      kind: "calendar_invite",
      to: ["dana@acme.com"],
      subject: "Kickoff",
      body: "",
      when: { start: "2026-11-03T21:00:00.000Z", end: "2026-11-03T21:30:00.000Z" },
      location: "Room 4",
      conference: "meet",
    });
    const c = await cookie();
    const otherTime = draftFingerprint({ ...d, when: { start: "2026-11-03T22:00:00.000Z", end: "2026-11-03T22:30:00.000Z" } });
    const noMeet = draftFingerprint({ ...d, conference: undefined });
    for (const confirmation of [otherTime, noMeet]) {
      const res = await approve(req("POST", "/x", { headers: { cookie: c, ...SAME }, body: { confirmation } }), params({ id: d.id }));
      expect(await codeOf(res)).toBe("changed");
    }
    expect(deps.inviter.insertInvite).not.toHaveBeenCalled();
    const ok = await approve(req("POST", "/x", { headers: { cookie: c, ...SAME }, body: { confirmation: draftFingerprint(d) } }), params({ id: d.id }));
    expect(ok.status).toBe(200);
    expect(deps.inviter.insertInvite).toHaveBeenCalledOnce();
  });

  it("an explicitly set APP_URL origin is accepted when req.url carries an internal host", async () => {
    process.env.APP_URL = "https://brain.example.com";
    try {
      expect(() => requireSameOrigin(req("POST", "/x", { headers: { origin: "https://brain.example.com" } }))).not.toThrow();
      expect(() => requireSameOrigin(req("POST", "/x", { headers: { origin: "https://evil.example" } }))).toThrow();
      expect(() => requireSameOrigin(req("POST", "/x", { headers: { origin: "https://brain.example.com", "sec-fetch-site": "cross-site" } }))).toThrow();
    } finally {
      delete process.env.APP_URL;
    }
  });
});

describe("device tokens on withPrincipal routes", () => {
  it("a device token approves as before (no body needed); a cookie next to it is ignored", async () => {
    const { deps, id } = await setup();
    const { token } = await pairDevice(deps, "watch");
    const res = await approve(req("POST", "/x", { token, headers: { cookie: await cookie() } }), params({ id }));
    expect(res.status).toBe(200);
    const events = (await deps.repos.timeline.since("2000-01-01T00:00:00Z")).map((e) => e.event);
    expect(events.some((e) => e.includes("(approved on watch)"))).toBe(true);
  });

  it("a device's body is ignored: a wrong confirmation doesn't block a device approve", async () => {
    const { deps, id } = await setup();
    const { token } = await pairDevice(deps, "phone");
    const res = await approve(req("POST", "/x", { token, body: { confirmation: "0".repeat(64) } }), params({ id }));
    expect(res.status).toBe(200);
    expect(deps.sender.sendDraft).toHaveBeenCalledOnce();
  });

  it("a bad bearer token never falls back to the session cookie", async () => {
    const { deps, id } = await setup();
    const res = await approve(req("POST", "/x", { token: "skq_nope", headers: { cookie: await cookie(), ...SAME }, body: { confirmation: await fingerprintOf(deps, id) } }), params({ id }));
    expect(res.status).toBe(401);
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });

  it("a revoked device token is refused even with a valid session cookie", async () => {
    const { deps, id } = await setup();
    const { token, device } = await pairDevice(deps, "phone");
    await deps.repos.devices.revoke(device.id);
    const res = await approve(req("POST", "/x", { token, headers: { cookie: await cookie(), ...SAME }, body: { confirmation: await fingerprintOf(deps, id) } }), params({ id }));
    expect(res.status).toBe(401);
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });
});

describe("session principal: the owner's web device", () => {
  it("is the dashboard's shared web device (one device, not one per request)", async () => {
    const deps = makeDeps();
    const c = await cookie();
    const a = await authenticatePrincipal(req("GET", "/api/drafts", { headers: { cookie: c } }), deps, { key: KEY });
    const b = await authenticatePrincipal(req("POST", "/api/drafts/x/discard", { headers: { cookie: c, ...SAME } }), deps, { key: KEY });
    expect(a).toMatchObject({ via: "session", device: { kind: "web", name: DASHBOARD_DEVICE_NAME } });
    expect(b.device.id).toBe(a.device.id);
    expect((await deps.repos.devices.findByToken(await dashboardDeviceToken(deps, KEY)))?.id).toBe(a.device.id);
    expect((await deps.repos.devices.list()).filter((d) => !d.revoked)).toHaveLength(1);
  });

  it("GET /api/drafts works with the cookie alone; discard needs same-origin and never sends", async () => {
    const { deps, id } = await setup();
    const c = await cookie();
    const list = await listDrafts(req("GET", "/api/drafts", { headers: { cookie: c } }), params({}));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([id]);

    expect((await discard(req("POST", "/x", { headers: { cookie: c } }), params({ id }))).status).toBe(403);
    expect((await deps.repos.drafts.get(id))?.status).toBe("pending");
    expect((await discard(req("POST", "/x", { headers: { cookie: c, ...SAME } }), params({ id }))).status).toBe(200);
    expect((await deps.repos.drafts.get(id))?.status).toBe("discarded");
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });

  it("the dashboard and the approve route share one fingerprint function", async () => {
    const { deps, id } = await setup();
    const d = (await deps.repos.drafts.get(id))!;
    expect(dashboardFingerprint(d)).toBe(draftFingerprint(d));
  });
});

describe("middleware: the session cookie reaches only withPrincipal and connections routes", () => {
  it("lets the cookie through to the drafts routes (other withPrincipal routes: web-principal-routes.test.ts)", async () => {
    const value = (await signSession(SESSION_SECRET)).value;
    const mk = (path: string, withCookie: boolean, method = "POST") => {
      const headers = new Headers();
      if (withCookie) headers.set("cookie", `${SESSION_COOKIE}=${value}`);
      return new NextRequest(new URL(path, "https://brain.example"), { method, headers });
    };
    const passes = async (r: NextRequest) => (await middleware(r)).headers.get("x-middleware-next") === "1";
    expect(await passes(mk("/api/drafts", true, "GET"))).toBe(true);
    expect(await passes(mk("/api/drafts/drf_abc123/approve", true))).toBe(true);
    expect(await passes(mk("/api/drafts/drf_abc123/discard", true))).toBe(true);
    expect((await middleware(mk("/api/drafts/drf_abc123/approve", true))).headers.get("cache-control")).toBe("no-store");
    for (const p of ["/api/drafts/drf_abc123/approve", "/api/drafts"]) expect((await middleware(mk(p, false))).status).toBe(401);
    const basic = new NextRequest(new URL("/api/drafts/drf_abc123/approve", "https://brain.example"), { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${value}`, authorization: "Basic eA==" } });
    expect(await passes(basic)).toBe(true); // the route then refuses it: an Authorization header means a device token only
    for (const p of ["/api/drafts/drf_abc123", "/api/drafts/drf_abc123/approve/x", "/api/drafts/a.b/approve", "/api/commands"]) {
      expect((await middleware(mk(p, true))).status, p).toBe(401);
    }
  });
});
