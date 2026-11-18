import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import { makeDeps, pairDevice, params, req, type TestDeps } from "./fakes";
import { POST as register } from "@/app/api/devices/register/route";
import { deliverAlert } from "@/lib/push/alerts";
import { buildWebPushPayload, deliverWebPush, WEB_PUSH_BODY_MAX, WEB_PUSH_TTL_SECONDS } from "@/lib/push/web-alerts";
import { isAllowedPushEndpoint, isValidP256dh, isValidPushAuth, pushEndpointProblem } from "@/lib/push/endpoint";
import {
  NoopWebPushSender,
  outcomeForStatus,
  retryAfterSeconds,
  VapidWebPushSender,
  webPushSenderFromEnv,
} from "@/lib/push/webpush";
import { WebPushStore } from "@/lib/push/webpush-store";
import { nudgeCommandTarget } from "@/lib/commands/nudge";
import { MemoryKV } from "./fakes";
import { RegisterDeviceSchema, type WebPushSubscription } from "@/lib/models";
import { renderServiceWorker } from "@/lib/pwa/sw";

// A real-shaped P-256 point (0x04 || X || Y) and a 16-byte auth secret.
const P256DH = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url");
const AUTH = randomBytes(16).toString("base64url");
const FCM_EP = "https://fcm.googleapis.com/fcm/send/abc123:APA91bXYZ";
const APPLE_EP = "https://web.push.apple.com/QGuQyavXutnMH3";

function sub(endpoint = FCM_EP): WebPushSubscription {
  return { endpoint, keys: { p256dh: P256DH, auth: AUTH } };
}

async function registerWeb(deps: TestDeps, token: string, s: WebPushSubscription = sub()) {
  return register(req("POST", "/api/devices/register", { token, body: { transport: "webpush", subscription: s } }), params({}));
}

afterEach(() => {
  setDeps(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Web Push endpoint allowlist", () => {
  it.each([
    FCM_EP,
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk",
    APPLE_EP,
    "https://api.push.apple.com/3/device/x",
    "https://wns2-by3p.notify.windows.com/w/?token=BQYAAA",
    "https://FCM.googleapis.com/fcm/send/x",
  ])("allows %s", (ep) => {
    expect(isAllowedPushEndpoint(ep)).toBe(true);
  });

  it.each([
    ["http://fcm.googleapis.com/fcm/send/x", "not_https"],
    ["https://fcm.googleapis.com:443/fcm/send/x", "port"],
    ["https://fcm.googleapis.com:8443/fcm/send/x", "port"],
    ["https://user:pw@fcm.googleapis.com/fcm/send/x", "credentials"],
    ["https://user@fcm.googleapis.com/fcm/send/x", "credentials"],
    ["https://evil.example/fcm/send/x", "host"],
    ["https://fcm.googleapis.com.evil.example/x", "host"],
    ["https://evilfcm.googleapis.com/x", "host"],
    ["https://push.apple.com/x", "host"],
    ["https://evilpush.apple.com/x", "host"],
    ["https://a..push.apple.com/x", "not_a_url"],
    ["https://fcm.googleapis.com./x", "host"],
    ["https://127.0.0.1/x", "host"],
    ["https://[::1]/x", "host"],
    ["https://127.0.0.1%2enotify.windows.com/a", "host"],
    ["https://localhost%2Epush.apple.com/x", "host"],
    ["https://169.254.169.254%2Epush.apple.com/x", "host"],
    ["https://fcm%2Egoogleapis.com/x", "host"],
    ["https:/fcm.googleapis.com/x", "not_a_url"],
    ["https:fcm.googleapis.com/x", "not_a_url"],
    ["https://localhost/x", "host"],
    ["https://fcm.googleapis.com/x y", "not_a_url"],
    ["https://fcm.googleapis.com\\@evil.example/x", "not_a_url"],
    ["ftp://fcm.googleapis.com/x", "not_https"],
    ["not a url", "not_a_url"],
    [`https://fcm.googleapis.com/${"a".repeat(2100)}`, "too_long"],
  ])("refuses %s (%s)", (ep, why) => {
    const problem = pushEndpointProblem(ep);
    expect(problem).not.toBeNull();
    // The exact reason matters less than refusing; check it where it is unambiguous.
    if (why !== "not_a_url") expect(problem).toBe(why);
  });

  it("checks subscription keys", () => {
    expect(isValidP256dh(P256DH)).toBe(true);
    expect(isValidP256dh(`${P256DH}=`)).toBe(true);
    expect(isValidP256dh(Buffer.concat([Buffer.from([2]), randomBytes(64)]).toString("base64url"))).toBe(false); // not uncompressed
    expect(isValidP256dh(randomBytes(32).toString("base64url"))).toBe(false);
    expect(isValidP256dh("not+base64url/")).toBe(false);
    expect(isValidPushAuth(AUTH)).toBe(true);
    expect(isValidPushAuth(randomBytes(15).toString("base64url"))).toBe(false);
  });
});

describe("register body (contract)", () => {
  it("native body is unchanged: transport defaults to fcm", () => {
    expect(RegisterDeviceSchema.parse({ fcmToken: "tok", device: "phone" })).toEqual({ transport: "fcm", fcmToken: "tok", device: "phone" });
  });

  it("parses a browser subscription and strips extra fields", () => {
    const parsed = RegisterDeviceSchema.parse({ transport: "webpush", subscription: { ...sub(), expirationTime: null }, url: "https://evil.example" });
    expect(parsed).toEqual({ transport: "webpush", subscription: sub() });
  });

  it("refuses unknown transports, bad endpoints and missing keys", () => {
    expect(RegisterDeviceSchema.safeParse({ transport: "apns", fcmToken: "t", device: "phone" }).success).toBe(false);
    expect(RegisterDeviceSchema.safeParse({ transport: "webpush", subscription: sub("https://evil.example/x") }).success).toBe(false);
    expect(RegisterDeviceSchema.safeParse({ transport: "webpush", subscription: { endpoint: FCM_EP } }).success).toBe(false);
    expect(RegisterDeviceSchema.safeParse({ transport: "webpush", fcmToken: "t", device: "phone" }).success).toBe(false);
  });
});

describe("POST /api/devices/register with transport webpush", () => {
  it("stores a web device's subscription sealed, not in the clear", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const { token, device } = await pairDevice(deps, "web");
    const res = await registerWeb(deps, token);
    expect(res.status).toBe(200);
    expect(await deps.webPushSubs.get(device.id)).toEqual(sub());
    const raw = await deps.kv.get(`t:webpush:dev:${device.id}`);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("fcm.googleapis.com");
    expect(raw).not.toContain(AUTH);
    // No FCM token on a browser, so it never counts for FCM or command nudges.
    expect(await deps.repos.devices.pushTokens()).toEqual([]);
  });

  it("400 for a bad endpoint, nothing stored", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const { token, device } = await pairDevice(deps, "web");
    const res = await registerWeb(deps, token, sub("https://169.254.169.254/latest/meta-data"));
    expect(res.status).toBe(400);
    expect(await deps.webPushSubs.get(device.id)).toBeNull();
  });

  it("only web devices may use webpush, and web devices may not use FCM", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const phone = await pairDevice(deps, "phone");
    const r1 = await registerWeb(deps, phone.token);
    expect(r1.status).toBe(400);
    expect(await r1.json()).toMatchObject({ code: "transport_not_allowed" });
    expect(await deps.webPushSubs.get(phone.device.id)).toBeNull();

    const web = await pairDevice(deps, "web");
    const r2 = await register(req("POST", "/api/devices/register", { token: web.token, body: { fcmToken: "fcm-x", device: "phone" } }), params({}));
    expect(r2.status).toBe(400);
    expect(await r2.json()).toMatchObject({ code: "transport_not_allowed" });
    expect(await deps.repos.devices.pushTokens()).toEqual([]);

    // Native FCM registration still works as before.
    const r3 = await register(req("POST", "/api/devices/register", { token: phone.token, body: { fcmToken: "fcm-p", device: "phone" } }), params({}));
    expect(r3.status).toBe(200);
    expect(await deps.repos.devices.pushTokens()).toEqual(["fcm-p"]);
  });

  it("503 when VAPID isn't configured", async () => {
    const deps = makeDeps();
    deps.webPushFake.enabled = false;
    setDeps(deps);
    const { token, device } = await pairDevice(deps, "web");
    const res = await registerWeb(deps, token);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "webpush_disabled" });
    expect(await deps.webPushSubs.get(device.id)).toBeNull();
  });

  it("an endpoint belongs to one device: registering it elsewhere takes it away", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const a = await pairDevice(deps, "web");
    const b = await pairDevice(deps, "web");
    await registerWeb(deps, a.token);
    await registerWeb(deps, b.token);
    expect(await deps.webPushSubs.get(a.device.id)).toBeNull();
    expect(await deps.webPushSubs.get(b.device.id)).toEqual(sub());

    // B re-subscribes with a new endpoint; the old index entry goes, so A can take the old one cleanly.
    await registerWeb(deps, b.token, sub(APPLE_EP));
    expect(await deps.kv.get(`t:webpush:ep:${(await import("@/lib/crypto")).sha256(FCM_EP)}`)).toBeNull();
    await registerWeb(deps, a.token);
    expect(await deps.webPushSubs.get(a.device.id)).toEqual(sub());
    expect(await deps.webPushSubs.get(b.device.id)).toEqual(sub(APPLE_EP));

    await deliverAlert(deps, { title: "t", body: "b", data: { kind: "email" } });
    expect(deps.webPushFake.sent.map((s) => s.sub.endpoint).sort()).toEqual([APPLE_EP, FCM_EP].sort());
  });
});

describe("Web Push payload", () => {
  it("carries title, body, kind, importance and ids only", () => {
    const p = buildWebPushPayload({
      title: "Reply needed: Acme",
      body: "Dana asked for pricing",
      priority: "high",
      data: {
        kind: "email",
        importance: "CRITICAL",
        client: "Acme",
        messageId: "m_1",
        threadId: "t_1",
        draftId: "d_1",
        draftBody: "Hi Dana, here is the pricing",
        url: "https://evil.example",
        to: "dana@acme.example",
      } as Record<string, string>,
    });
    expect(p).toEqual({ title: "Reply needed: Acme", body: "Dana asked for pricing", kind: "email", importance: "CRITICAL", messageId: "m_1", threadId: "t_1" });
  });

  it("drops unknown kinds and odd ids, clips long text, never an empty title", () => {
    const p = buildWebPushPayload({ title: "  ", body: "x".repeat(5000), data: { kind: "open_url", importance: "MEGA", commitmentId: "c 1<script>" } });
    expect(p.title).toBe("SideKiqq");
    expect(p.body.length).toBe(WEB_PUSH_BODY_MAX);
    expect(p).not.toHaveProperty("kind");
    expect(p).not.toHaveProperty("importance");
    expect(p).not.toHaveProperty("commitmentId");
    expect(Buffer.byteLength(JSON.stringify(buildWebPushPayload({ title: "é".repeat(500), body: "é".repeat(5000) })))).toBeLessThan(3000);
  });
});

describe("deliverAlert → Web Push", () => {
  async function setup() {
    const deps = makeDeps();
    setDeps(deps);
    const web = await pairDevice(deps, "web");
    await deps.webPushSubs.set(web.device.id, sub());
    return { deps, web };
  }

  it("sends to subscribed web devices with TTL 24 h and urgency by importance", async () => {
    const { deps } = await setup();
    const phone = await pairDevice(deps, "phone");
    await deps.repos.devices.setFcmToken(phone.device.id, "fcm-p", "phone");
    expect(await deliverAlert(deps, { title: "Overdue", body: "Send agreement", data: { kind: "commitment_overdue", commitmentId: "c1", importance: "HIGH" } })).toBe(1);
    expect(deps.webPushFake.sent).toHaveLength(1);
    const s = deps.webPushFake.sent[0]!;
    expect(s.opts).toEqual({ ttlSeconds: WEB_PUSH_TTL_SECONDS, urgency: "normal" });
    expect(JSON.parse(s.payload)).toEqual({ title: "Overdue", body: "Send agreement", kind: "commitment_overdue", importance: "HIGH", commitmentId: "c1" });
    // FCM still gets it, and only native tokens.
    expect(deps.pushFake.sent.map((x) => x.tokens)).toEqual([["fcm-p"]]);

    await deliverAlert(deps, { title: "Now", body: "b", data: { kind: "email", importance: "CRITICAL" } });
    expect(deps.webPushFake.sent[1]!.opts.urgency).toBe("high");
  });

  it("skips revoked and unsubscribed web devices and non-web devices", async () => {
    const { deps, web } = await setup();
    await pairDevice(deps, "web"); // no subscription
    const other = await pairDevice(deps, "web");
    await deps.webPushSubs.set(other.device.id, sub(APPLE_EP));
    await deps.repos.devices.revoke(other.device.id);
    await deliverAlert(deps, { title: "t", body: "b", data: { kind: "email" } });
    expect(deps.webPushFake.sent.map((s) => s.sub.endpoint)).toEqual([FCM_EP]);
    expect(web.device.kind).toBe("web");
  });

  it.each([404, 410])("%i clears the subscription", async (code) => {
    const { deps, web } = await setup();
    deps.webPushFake.outcomes.set(FCM_EP, outcomeForStatus(code));
    await deliverAlert(deps, { title: "t", body: "b", data: { kind: "email" } });
    expect(await deps.webPushSubs.get(web.device.id)).toBeNull();
  });

  it.each([400, 413, 500, 503])("%i keeps the subscription", async (code) => {
    const { deps, web } = await setup();
    deps.webPushFake.outcomes.set(FCM_EP, outcomeForStatus(code));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await deliverAlert(deps, { title: "t", body: "b", data: { kind: "email" } });
    expect(await deps.webPushSubs.get(web.device.id)).toEqual(sub());
  });

  it("a locally blocked endpoint is cleared", async () => {
    const { deps, web } = await setup();
    deps.webPushFake.outcomes.set(FCM_EP, { status: "blocked" });
    await deliverAlert(deps, { title: "t", body: "b", data: { kind: "email" } });
    expect(await deps.webPushSubs.get(web.device.id)).toBeNull();
  });

  it("429 backs that endpoint off for Retry-After, then resumes", async () => {
    const { deps, web } = await setup();
    deps.webPushFake.outcomes.set(FCM_EP, outcomeForStatus(429, { "retry-after": "120" }));
    await deliverAlert(deps, { title: "a", body: "b", data: { kind: "email" } });
    deps.webPushFake.outcomes.delete(FCM_EP);
    await deliverAlert(deps, { title: "b", body: "b", data: { kind: "email" } });
    expect(deps.webPushFake.sent).toHaveLength(1);
    expect(await deps.webPushSubs.get(web.device.id)).toEqual(sub());
    deps.setNow(new Date(deps.clock().getTime() + 121_000));
    await deliverAlert(deps, { title: "c", body: "b", data: { kind: "email" } });
    expect(deps.webPushFake.sent.map((s) => JSON.parse(s.payload).title)).toEqual(["a", "c"]);
  });

  it("a Web Push failure never blocks FCM or the alert log", async () => {
    const { deps } = await setup();
    const phone = await pairDevice(deps, "phone");
    await deps.repos.devices.setFcmToken(phone.device.id, "fcm-p", "phone");
    deps.webPushFake.error = new Error("boom");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await deliverAlert(deps, { title: "t", body: "b", data: { kind: "email" } })).toBe(1);
    expect(deps.pushFake.sent).toHaveLength(1);
    expect((await deps.repos.alerts.since(null, 10)).items).toHaveLength(1);
  });

  it("counts as delivered when only a browser got it", async () => {
    const { deps } = await setup();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await deliverAlert(deps, { title: "t", body: "b", data: { kind: "not_a_kind" } })).toBe(1);
    expect(deps.webPushFake.sent).toHaveLength(1);
  });

  it("disabled sender sends nothing", async () => {
    const { deps } = await setup();
    deps.webPushFake.enabled = false;
    expect(await deliverWebPush(deps, { title: "t", body: "b" })).toEqual({ sent: 0, attempted: 0 });
    expect(deps.webPushFake.sent).toHaveLength(0);
  });
});

describe("no silent pushes to browsers", () => {
  it("the command nudge never targets a web device", async () => {
    const deps = makeDeps();
    const { device } = await pairDevice(deps, "web");
    // Even if a token got onto the record somehow.
    const forced = { ...device, fcmToken: "fcm-w" };
    expect(await nudgeCommandTarget(deps, forced, "cmd_1")).toBe("no_token");
    expect(deps.pushFake.dataSent).toHaveLength(0);
  });
});

describe("VapidWebPushSender", () => {
  function fakeLib(impl: (...a: unknown[]) => Promise<unknown>) {
    const sendNotification = vi.fn(impl);
    return { lib: { sendNotification } as unknown as typeof import("web-push"), sendNotification };
  }

  it("sends with VAPID details, TTL and urgency", async () => {
    const { lib, sendNotification } = fakeLib(async () => ({ statusCode: 201, body: "", headers: {} }));
    const s = new VapidWebPushSender("pub", "priv", "mailto:owner@example.com", async () => lib);
    expect(await s.send(sub(), "{}", { ttlSeconds: 86400, urgency: "high" })).toEqual({ status: "sent" });
    expect(sendNotification).toHaveBeenCalledWith(sub(), "{}", expect.objectContaining({
      vapidDetails: { subject: "mailto:owner@example.com", publicKey: "pub", privateKey: "priv" },
      TTL: 86400,
      urgency: "high",
    }));
  });

  it("maps WebPushError status codes", async () => {
    const err = Object.assign(new Error("Received unexpected response code"), { statusCode: 410, headers: {} });
    const { lib } = fakeLib(async () => {
      throw err;
    });
    const s = new VapidWebPushSender("pub", "priv", "mailto:o@example.com", async () => lib);
    expect(await s.send(sub(), "{}", { ttlSeconds: 1, urgency: "normal" })).toEqual({ status: "gone", code: 410 });

    const rl = Object.assign(new Error("slow down"), { statusCode: 429, headers: { "Retry-After": "90" } });
    const s2 = new VapidWebPushSender("pub", "priv", "mailto:o@example.com", async () => fakeLib(async () => { throw rl; }).lib);
    expect(await s2.send(sub(), "{}", { ttlSeconds: 1, urgency: "normal" })).toEqual({ status: "rate_limited", retryAfterSeconds: 90 });

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s3 = new VapidWebPushSender("pub", "priv", "mailto:o@example.com", async () => fakeLib(async () => { throw new Error("ECONNRESET"); }).lib);
    expect(await s3.send(sub(), "{}", { ttlSeconds: 1, urgency: "normal" })).toEqual({ status: "failed" });
  });

  it("never POSTs to an endpoint off the allowlist", async () => {
    const { lib, sendNotification } = fakeLib(async () => ({ statusCode: 201 }));
    const s = new VapidWebPushSender("pub", "priv", "mailto:o@example.com", async () => lib);
    expect(await s.send(sub("http://10.0.0.1/x"), "{}", { ttlSeconds: 1, urgency: "normal" })).toEqual({ status: "blocked" });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("status and Retry-After mapping", () => {
    expect(outcomeForStatus(201)).toEqual({ status: "sent" });
    expect(outcomeForStatus(413)).toEqual({ status: "failed", code: 413 });
    expect(retryAfterSeconds(undefined)).toBe(300);
    expect(retryAfterSeconds("5")).toBe(60);
    expect(retryAfterSeconds("99999")).toBe(3600);
    expect(retryAfterSeconds("garbage")).toBe(300);
    const now = Date.parse("2026-11-18T12:00:00Z");
    expect(retryAfterSeconds("Wed, 18 Nov 2026 12:10:00 GMT", now)).toBe(600);
  });

  it("from env: off unless all three VAPID vars are set and the subject is valid", () => {
    expect(webPushSenderFromEnv()).toBeInstanceOf(NoopWebPushSender);
    const pub = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url");
    const priv = randomBytes(32).toString("base64url");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("VAPID_PUBLIC_KEY", "pub");
    vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    vi.stubEnv("VAPID_SUBJECT", "mailto:owner@example.com");
    expect(webPushSenderFromEnv().enabled).toBe(false); // malformed keys
    vi.stubEnv("VAPID_PUBLIC_KEY", pub);
    vi.stubEnv("VAPID_PRIVATE_KEY", priv);
    vi.stubEnv("VAPID_SUBJECT", "owner@example.com");
    expect(webPushSenderFromEnv().enabled).toBe(false); // bad subject
    vi.stubEnv("VAPID_SUBJECT", "mailto:owner@example.com");
    const s = webPushSenderFromEnv();
    expect(s.enabled).toBe(true);
    expect(s.publicKey).toBe(pub);
  });
});

describe("WebPushStore", () => {
  it("reads with the previous key during rotation; an unreadable record is null", async () => {
    const kv = new MemoryKV();
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    await new WebPushStore(kv, "t", () => ({ current: oldKey })).set("dev_1", sub());
    expect(await new WebPushStore(kv, "t", () => ({ current: newKey, previous: oldKey })).get("dev_1")).toEqual(sub());
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await new WebPushStore(kv, "t", () => ({ current: newKey })).get("dev_1")).toBeNull();
  });

  it("a sealed record can't be moved to another device id (AAD)", async () => {
    const kv = new MemoryKV();
    const key = randomBytes(32);
    const store = new WebPushStore(kv, "t", () => ({ current: key }));
    await store.set("dev_1", sub());
    await kv.set("t:webpush:dev:dev_2", (await kv.get("t:webpush:dev:dev_1"))!);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await store.get("dev_2")).toBeNull();
  });

  it("clearIfEndpoint keeps a newer subscription", async () => {
    const kv = new MemoryKV();
    const store = new WebPushStore(kv, "t", () => ({ current: randomBytes(32).fill(7) }));
    await store.set("dev_1", sub(APPLE_EP));
    expect(await store.clearIfEndpoint("dev_1", FCM_EP)).toBe(false);
    expect(await store.get("dev_1")).toEqual(sub(APPLE_EP));
    expect(await store.clearIfEndpoint("dev_1", APPLE_EP)).toBe(true);
    expect(await store.get("dev_1")).toBeNull();
  });
});

// ---- Service worker push handlers ------------------------------------------------------------

const ORIGIN = "https://app.sidekiqq.test";

function loadPushWorker(windows: { url: string; navigateThrows?: boolean }[] = []) {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const shown: { title: string; options: any }[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const focused: string[] = [];
  const matchOpts: any[] = [];
  const clientWindows = windows.map((w) => ({
    url: w.url,
    focus: async function (this: any) {
      focused.push(w.url);
      return this;
    },
    navigate: async (p: string) => {
      if (w.navigateThrows) throw new TypeError("not controlled");
      navigated.push(p);
      return null;
    },
  }));
  const self = {
    location: new URL(ORIGIN + "/service-worker"),
    addEventListener: (type: string, fn: (e: any) => void) => (listeners[type] ??= []).push(fn),
    skipWaiting: async () => undefined,
    registration: {
      showNotification: async (title: string, options: any) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async (opts: any) => {
        matchOpts.push(opts);
        return clientWindows;
      },
      openWindow: async (p: string) => {
        opened.push(p);
        return null;
      },
    },
  };
  const ctx = vm.createContext({ self, caches: {}, fetch: async () => undefined, URL, Promise, console, Object });
  vm.runInContext(renderServiceWorker("test"), ctx, { filename: "service-worker.js" });

  async function push(data: unknown) {
    let p: Promise<unknown> = Promise.resolve();
    const evData =
      data === undefined
        ? null
        : {
            json: () => (typeof data === "string" ? JSON.parse(data) : data),
          };
    for (const fn of listeners.push ?? []) fn({ data: evData, waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  }
  async function click(data: unknown) {
    let p: Promise<unknown> = Promise.resolve();
    let closed = false;
    for (const fn of listeners.notificationclick ?? [])
      fn({ notification: { data, close: () => (closed = true) }, action: "", waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
    return closed;
  }
  return { push, click, shown, opened, navigated, focused, matchOpts };
}

describe("service worker: push alerts", () => {
  it("shows a notification from title/body/kind only, with no actions", async () => {
    const w = loadPushWorker();
    await w.push({ title: "Overdue", body: "Send agreement", kind: "commitment_overdue", importance: "CRITICAL", url: "https://evil.example", actions: [{ action: "approve" }] });
    expect(w.shown).toHaveLength(1);
    const { title, options } = w.shown[0]!;
    expect(title).toBe("Overdue");
    expect(options.body).toBe("Send agreement");
    expect(options.actions).toBeUndefined();
    expect(options.requireInteraction).toBe(true);
    expect(JSON.parse(JSON.stringify(options.data))).toEqual({ kind: "commitment_overdue" });
    expect(JSON.stringify(options)).not.toContain("evil.example");
  });

  it("always shows something, even for an empty or broken payload", async () => {
    const w = loadPushWorker();
    await w.push(undefined);
    await w.push("{not json");
    await w.push({ title: 42, body: null, kind: "__proto__" });
    expect(w.shown.map((s) => s.title)).toEqual(["SideKiqq", "SideKiqq", "SideKiqq"]);
    expect(w.shown.every((s) => s.options.data.kind === null)).toBe(true);
  });

  it("a tap opens a fixed same-origin path chosen by kind", async () => {
    const w = loadPushWorker();
    expect(await w.click({ kind: "commitment_overdue" })).toBe(true);
    await w.click({ kind: "connection_needs_reauth" });
    await w.click({ kind: "email" });
    await w.click({ kind: "constructor", url: "https://evil.example" });
    await w.click(null);
    expect(w.opened).toEqual(["/dashboard/commitments", "/dashboard/connections", "/dashboard", "/dashboard", "/dashboard"]);
  });

  it("focuses an open dashboard window instead of opening another", async () => {
    const w = loadPushWorker([{ url: "https://other.example/dashboard" }, { url: `${ORIGIN}/dashboard/talk` }]);
    await w.click({ kind: "commitment_overdue" });
    expect(w.focused).toEqual([`${ORIGIN}/dashboard/talk`]);
    expect(w.navigated).toEqual(["/dashboard/commitments"]);
    expect(w.opened).toEqual([]);
  });
});

describe("the real web-push library accepts our request", () => {
  it("builds an encrypted, VAPID-signed request with our options", async () => {
    const { createECDH } = await import("node:crypto");
    const webpush = (await import("web-push")).default;
    const vapid = webpush.generateVAPIDKeys();
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const s: WebPushSubscription = { endpoint: FCM_EP, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
    expect(RegisterDeviceSchema.safeParse({ transport: "webpush", subscription: s }).success).toBe(true);
    const payload = JSON.stringify(buildWebPushPayload({ title: "t", body: "b", data: { kind: "email" } }));
    const details = webpush.generateRequestDetails(s, payload, {
      vapidDetails: { subject: "mailto:owner@example.com", publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: WEB_PUSH_TTL_SECONDS,
      urgency: "high",
    });
    expect(details.endpoint).toBe(FCM_EP);
    expect(details.method).toBe("POST");
    expect(details.headers).toMatchObject({ TTL: WEB_PUSH_TTL_SECONDS, Urgency: "high", "Content-Encoding": "aes128gcm" });
    expect(String(details.headers.Authorization)).toMatch(/^vapid t=.+, k=/);
    expect(Buffer.isBuffer(details.body)).toBe(true);
    expect(details.body!.toString()).not.toContain("email"); // encrypted
  });
});

describe("service worker: push alerts (review fixes)", () => {
  it("tags by the alert's own id, so separate alerts don't replace each other", async () => {
    const w = loadPushWorker();
    await w.push({ title: "a", body: "b", kind: "email", messageId: "m1" });
    await w.push({ title: "a", body: "b", kind: "email", messageId: "m2" });
    await w.push({ title: "a", body: "b", kind: "email" });
    await w.push({ title: "a", body: "b", kind: "email", messageId: "bad id<" });
    expect(w.shown.map((s) => s.options.tag)).toEqual(["sk-email-m1", "sk-email-m2", undefined, undefined]);
  });

  it("only looks at controlled windows, and doesn't reload one already on the path", async () => {
    const w = loadPushWorker([{ url: `${ORIGIN}/dashboard/commitments` }]);
    await w.click({ kind: "commitment_overdue" });
    expect(w.matchOpts[0]).not.toHaveProperty("includeUncontrolled");
    expect(w.focused).toEqual([`${ORIGIN}/dashboard/commitments`]);
    expect(w.navigated).toEqual([]);
    expect(w.opened).toEqual([]);
  });

  it("falls back to opening a window when navigate fails", async () => {
    const w = loadPushWorker([{ url: `${ORIGIN}/dashboard`, navigateThrows: true }]);
    await w.click({ kind: "connection_needs_reauth" });
    expect(w.opened).toEqual(["/dashboard/connections"]);
  });
});
