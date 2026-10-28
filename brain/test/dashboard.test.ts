import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { setDeps } from "@/lib/deps";
import { makeDeps } from "./fakes";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, sessionCookieOptions, signSession, verifySession, sessionSecretFromEnv } from "@/lib/dashboard/session";
import { safeNextPath, isDashboardPath } from "@/lib/dashboard/guard";
import { middleware, config as middlewareConfig } from "@/middleware";
import {
  CONFIRM_VALUE,
  approveDraftFromDashboard,
  checkApprovalConfirmation,
  completeCommitmentFromDashboard,
  discardDraftFromDashboard,
  draftFingerprint,
} from "@/lib/dashboard/approval";
import { DASHBOARD_DEVICE_NAME, dashboardDeviceToken } from "@/lib/dashboard/device-bridge";

const SECRET = "test-session-secret-0123456789abcdef";

// ----------------------------------------------------------------------------- session

describe("dashboard session cookie", () => {
  const now = new Date("2026-10-21T12:00:00Z");

  it("signs and verifies a 7-day session", async () => {
    const t = await signSession(SECRET, now);
    expect(t.value).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(t.expiresAt.getTime() - now.getTime()).toBe(SESSION_TTL_SECONDS * 1000);
    expect(await verifySession(t.value, SECRET, now)).toBe(true);
    expect(await verifySession(t.value, SECRET, new Date(now.getTime() + 6.9 * 86_400_000))).toBe(true);
  });

  it("rejects expired sessions", async () => {
    const t = await signSession(SECRET, now);
    expect(await verifySession(t.value, SECRET, new Date(now.getTime() + SESSION_TTL_SECONDS * 1000 + 1))).toBe(false);
  });

  it("rejects a different secret", async () => {
    const t = await signSession(SECRET, now);
    expect(await verifySession(t.value, `${SECRET}x`, now)).toBe(false);
    expect(await verifySession(t.value, null, now)).toBe(false);
  });

  it("rejects tampering with the expiry, nonce or signature", async () => {
    const t = await signSession(SECRET, now);
    const [v, exp, nonce, sig] = t.value.split(".") as [string, string, string, string];
    const later = String(Number(exp) + 60);
    expect(await verifySession([v, later, nonce, sig].join("."), SECRET, now)).toBe(false);
    expect(await verifySession([v, exp, `${nonce}A`, sig].join("."), SECRET, now)).toBe(false);
    const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    expect(await verifySession([v, exp, nonce, flipped].join("."), SECRET, now)).toBe(false);
    expect(await verifySession(["v2", exp, nonce, sig].join("."), SECRET, now)).toBe(false);
  });

  it("rejects garbage without throwing", async () => {
    for (const bad of ["", "x", "a.b.c.d", "v1.1.2", "v1.notanumber.n.s", "v1.9999999999.n.!!!", "v1." + "9".repeat(300), undefined, null]) {
      expect(await verifySession(bad as string, SECRET, now)).toBe(false);
    }
  });

  it("refuses a token whose lifetime exceeds what we issue", async () => {
    const t = await signSession(SECRET, now, SESSION_TTL_SECONDS * 4);
    expect(await verifySession(t.value, SECRET, now)).toBe(false);
  });

  it("requires a long SESSION_SECRET", async () => {
    await expect(signSession("short", now)).rejects.toThrow(/SESSION_SECRET/);
    expect(sessionSecretFromEnv({ SESSION_SECRET: "short" })).toBeNull();
    expect(sessionSecretFromEnv({})).toBeNull();
    expect(sessionSecretFromEnv({ SESSION_SECRET: SECRET })).toBe(SECRET);
  });

  it("cookie is httpOnly, Secure, SameSite=Strict", () => {
    const o = sessionCookieOptions(new Date());
    expect(o).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/" });
  });
});

// ----------------------------------------------------------------------------- middleware

describe("dashboard middleware protection", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  function get(path: string, cookie?: string, method = "GET") {
    const headers = new Headers();
    if (cookie) headers.set("cookie", `${SESSION_COOKIE}=${cookie}`);
    return new NextRequest(new URL(path, "https://brain.example"), { method, headers });
  }

  it("matches dashboard pages and keeps protecting the API", () => {
    expect(middlewareConfig.matcher).toEqual(expect.arrayContaining(["/api/:path*", "/dashboard/:path*"]));
    expect(isDashboardPath("/dashboard")).toBe(true);
    expect(isDashboardPath("/dashboard/drafts/drf_1")).toBe(true);
    expect(isDashboardPath("/dashboards")).toBe(false);
    expect(isDashboardPath("/login")).toBe(false);
  });

  it("redirects to /login without a session, keeping the destination", async () => {
    const res = await middleware(get("/dashboard/drafts?x=1"));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/dashboard/drafts?x=1");
  });

  it("redirects with a forged or expired cookie and clears it", async () => {
    const forged = await signSession("another-secret-that-is-long-enough-0000");
    const res = await middleware(get("/dashboard", forged.value));
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
  });

  it("returns 401 (not a redirect) for unauthenticated server-action POSTs", async () => {
    const res = await middleware(get("/dashboard/drafts/drf_1", undefined, "POST"));
    expect(res.status).toBe(401);
  });

  it("lets a valid session through with no-store caching", async () => {
    const t = await signSession(SECRET);
    const res = await middleware(get("/dashboard/commitments", t.value));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses every session when SESSION_SECRET is unset", async () => {
    const t = await signSession(SECRET);
    delete process.env.SESSION_SECRET;
    expect((await middleware(get("/dashboard", t.value))).status).toBe(303);
  });

  it("a session cookie does not authenticate the device API", async () => {
    const t = await signSession(SECRET);
    const res = await middleware(get("/api/commitments", t.value));
    expect(res.status).toBe(401);
  });

  it("post-login redirect only goes to dashboard paths", () => {
    expect(safeNextPath("/dashboard/drafts?x=1")).toBe("/dashboard/drafts?x=1");
    for (const bad of ["https://evil.example/dashboard", "//evil.example/dashboard", "/\\evil.example", "/api/drafts", "/login", "", null, "javascript:alert(1)"]) {
      expect(safeNextPath(bad)).toBe("/dashboard");
    }
  });
});

// ----------------------------------------------------------------------------- login (cookies mocked)

const jar = new Map<string, { value: string; options?: unknown }>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)!.value } : undefined),
    set: (n: string, value: string, options?: unknown) => jar.set(n, { value, options }),
    delete: (n: string) => jar.delete(n),
  }),
  headers: async () => new Headers(),
}));

describe("owner login", () => {
  beforeEach(() => {
    jar.clear();
    process.env.SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it("sets a verifiable session cookie for the right owner secret only", async () => {
    const { loginWithOwnerSecret, hasOwnerSession, logout } = await import("@/lib/dashboard/owner");
    const deps = makeDeps();
    expect(await loginWithOwnerSecret(deps, "wrong-secret-wrong-secret", "1.2.3.4")).toMatchObject({ ok: false });
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    expect(await loginWithOwnerSecret(deps, process.env.OWNER_SECRET!, "1.2.3.4")).toEqual({ ok: true });
    const c = jar.get(SESSION_COOKIE)!;
    expect(c.options).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict" });
    expect(await verifySession(c.value, SECRET)).toBe(true);
    expect(await hasOwnerSession()).toBe(true);
    await logout();
    expect(await hasOwnerSession()).toBe(false);
  });

  it("is disabled without SESSION_SECRET", async () => {
    const { loginWithOwnerSecret } = await import("@/lib/dashboard/owner");
    delete process.env.SESSION_SECRET;
    const r = await loginWithOwnerSecret(makeDeps(), process.env.OWNER_SECRET!, "1.2.3.4");
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/SESSION_SECRET/) });
    expect(jar.size).toBe(0);
  });

  it("rate-limits attempts per IP, even with the right secret", async () => {
    const { loginWithOwnerSecret, LOGIN_MAX_ATTEMPTS } = await import("@/lib/dashboard/owner");
    const deps = makeDeps();
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) await loginWithOwnerSecret(deps, "nope-nope-nope-nope", "9.9.9.9");
    const r = await loginWithOwnerSecret(deps, process.env.OWNER_SECRET!, "9.9.9.9");
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Too many/) });
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    expect(await loginWithOwnerSecret(deps, process.env.OWNER_SECRET!, "8.8.8.8")).toEqual({ ok: true });
  });
});

// ----------------------------------------------------------------------------- approve requires confirmation

describe("dashboard approve requires explicit confirmation", () => {
  const key = randomBytes(32);

  async function setup() {
    const deps = makeDeps();
    setDeps(deps); // the existing route handlers resolve deps via getDeps()
    const g = await deps.ws.createDraft({ to: ["dana@acme.com"], subject: "Proposal", body: "Hi Dana, attached." });
    const fu = await deps.repos.followups.upsert({ person: "Dana", client: "ACME", reason: "waiting", importance: "HIGH" });
    const d = await deps.repos.drafts.create({ providerDraftId: g.gmailDraftId, to: ["dana@acme.com"], subject: "Proposal", body: "Hi Dana, attached.", client: "ACME", followupId: fu.followUp.id });
    return { deps, d, fu };
  }

  it("checkApprovalConfirmation needs the confirm value and a matching fingerprint", async () => {
    const { d } = await setup();
    const fp = draftFingerprint(d);
    expect(checkApprovalConfirmation(null, { confirm: CONFIRM_VALUE, confirmation: fp })).toMatchObject({ ok: false, status: 404 });
    expect(checkApprovalConfirmation(d, {})).toMatchObject({ ok: false, status: 400 });
    expect(checkApprovalConfirmation(d, { confirmation: fp })).toMatchObject({ ok: false, status: 400 });
    expect(checkApprovalConfirmation(d, { confirm: "yes", confirmation: fp })).toMatchObject({ ok: false, status: 400 });
    expect(checkApprovalConfirmation(d, { confirm: CONFIRM_VALUE })).toMatchObject({ ok: false, status: 409 });
    expect(checkApprovalConfirmation({ ...d, body: "changed" }, { confirm: CONFIRM_VALUE, confirmation: fp })).toMatchObject({ ok: false, status: 409 });
    expect(checkApprovalConfirmation({ ...d, status: "sent" }, { confirm: CONFIRM_VALUE, confirmation: fp })).toMatchObject({ ok: false, status: 409 });
    expect(checkApprovalConfirmation(d, { confirm: CONFIRM_VALUE, confirmation: fp })).toEqual({ ok: true });
  });

  it("fingerprint covers recipients, cc, subject and body", async () => {
    const { d } = await setup();
    const fp = draftFingerprint(d);
    expect(draftFingerprint({ ...d, to: ["eve@evil.example"] })).not.toBe(fp);
    expect(draftFingerprint({ ...d, cc: ["x@y.z"] })).not.toBe(fp);
    expect(draftFingerprint({ ...d, subject: "Other" })).not.toBe(fp);
    expect(draftFingerprint({ ...d, body: "Other" })).not.toBe(fp);
  });

  it("never sends without confirmation", async () => {
    const { deps, d } = await setup();
    expect(await approveDraftFromDashboard(deps, d.id, {}, key)).toMatchObject({ ok: false });
    expect(await approveDraftFromDashboard(deps, d.id, { confirm: CONFIRM_VALUE, confirmation: "stale" }, key)).toMatchObject({ ok: false });
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    expect((await deps.repos.drafts.get(d.id))?.status).toBe("pending");
  });

  it("sends exactly once through the existing approve route after confirmation", async () => {
    const { deps, d, fu } = await setup();
    const form = { confirm: CONFIRM_VALUE, confirmation: draftFingerprint(d) };
    expect(await approveDraftFromDashboard(deps, d.id, form, key)).toEqual({ ok: true });
    expect(deps.sender.sendDraft).toHaveBeenCalledExactlyOnceWith(d.providerDraftId);
    expect((await deps.repos.drafts.get(d.id))?.status).toBe("sent");
    expect((await deps.repos.followups.get(fu.followUp.id))?.resolved).toBe(true);
    // Replaying the same confirmation is refused.
    expect(await approveDraftFromDashboard(deps, d.id, form, key)).toMatchObject({ ok: false });
    expect(deps.sender.sendDraft).toHaveBeenCalledOnce();
  });

  it("surfaces the route's 410 when the Gmail draft is gone, without sending", async () => {
    const { deps, d } = await setup();
    deps.ws.drafts.clear();
    const r = await approveDraftFromDashboard(deps, d.id, { confirm: CONFIRM_VALUE, confirmation: draftFingerprint(d) }, key);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/deleted/) });
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });

  it("discard and complete go through the existing routes and never send", async () => {
    const { deps, d } = await setup();
    expect(await discardDraftFromDashboard(deps, d.id, key)).toEqual({ ok: true });
    expect((await deps.repos.drafts.get(d.id))?.status).toBe("discarded");
    const { commitment } = await deps.repos.commitments.add({ who: "Stimmel", what: "Send pricing", source: { kind: "voice" }, confidence: "CONFIRMED" });
    expect(await completeCommitmentFromDashboard(deps, commitment.id, key)).toEqual({ ok: true });
    expect((await deps.repos.commitments.get(commitment.id))?.status).toBe("done");
    expect(await completeCommitmentFromDashboard(deps, "cmt_missing", key)).toMatchObject({ ok: false });
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
  });

  it("reuses one dashboard device, stores its token encrypted, and replaces it if revoked", async () => {
    const { deps } = await setup();
    const t1 = await dashboardDeviceToken(deps, key);
    const t2 = await dashboardDeviceToken(deps, key);
    expect(t2).toBe(t1);
    const devices = await deps.repos.devices.list();
    expect(devices.filter((x) => x.name === DASHBOARD_DEVICE_NAME)).toHaveLength(1);
    for (const k of deps.kv.keys()) expect(await deps.kv.get(k)).not.toBe(t1);
    await deps.repos.devices.revoke(devices[0]!.id);
    const t3 = await dashboardDeviceToken(deps, key);
    expect(t3).not.toBe(t1);
    expect(await deps.repos.devices.findByToken(t3)).not.toBeNull();
  });
});
