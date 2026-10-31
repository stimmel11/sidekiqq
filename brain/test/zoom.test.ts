import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import { makeDeps, MemoryKV, msg, pairDevice, params, req, ScriptedLLM, toolUse } from "./fakes";
import { POST as ask } from "@/app/api/ask/route";
import { ConnectionStore } from "@/lib/connectors/store";
import { invokeCapability } from "@/lib/connectors/invoke";
import { CapabilityDeniedError, ConnectionUnusableError, ReauthRequiredError } from "@/lib/connectors/types";
import { ZoomConnector } from "@/lib/connectors/zoom";
import { KvRefreshLock, ZOOM_MEETING_SCOPE, ZoomAuth, ZoomAuthError, zoomConfigFromEnv, ZoomNotConnectedError, type FetchLike } from "@/lib/connectors/zoom/auth";
import { isZoomJoinUrl, roomRequestBody, ZoomMeetings } from "@/lib/connectors/zoom/meetings";
import { ZoomApiError } from "@/lib/connectors/zoom/errors";

const NOW = new Date("2026-10-16T15:00:00Z");
const CFG = { clientId: "cid", clientSecret: "csecret", redirectUri: "https://brain.example/api/connections/zoom/callback" };

const kvs = new WeakMap<ConnectionStore, MemoryKV>();
function stableStore() {
  const kv = new MemoryKV(() => NOW.getTime());
  const key = randomBytes(32);
  const s = new ConnectionStore(kv, "t", () => ({ current: key }));
  kvs.set(s, kv);
  return s;
}
const kvOf = (s: ConnectionStore) => kvs.get(s)!;

async function connect(s: ConnectionStore, secret = "rt-1", scopes = [ZOOM_MEETING_SCOPE], connectedAt = NOW.toISOString()) {
  await s.save("zoom", { secret, secretKind: "refresh_token", grantedScopes: scopes, connectedAt });
}
/** Another instance rotated the token: same connection (connectedAt), new secret. */
async function rotateElsewhere(s: ConnectionStore, secret: string) {
  await s.update("zoom", (v) => ({ ...v, secret }));
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
const form = (c: Call) => new URLSearchParams(String(c.init.body));

afterEach(() => {
  delete process.env.ZOOM_CLIENT_ID;
  delete process.env.ZOOM_CLIENT_SECRET;
  delete process.env.ZOOM_REDIRECT_URI;
});

describe("the fixed Zoom room request (nobody is invited or emailed)", () => {
  it("instant room: only topic and duration come from the caller", () => {
    expect(roomRequestBody({ topic: "Sync" })).toEqual({
      topic: "Sync",
      type: 1,
      duration: 30,
      settings: {
        join_before_host: false,
        waiting_room: true,
        approval_type: 2,
        registrants_email_notification: false,
        registrants_confirmation_email: false,
        alternative_hosts: "",
        alternative_hosts_email_notification: false,
        email_notification: false,
        auto_recording: "none",
        auto_start_meeting_summary: false,
        auto_start_ai_companion_questions: false,
        push_change_to_calendar: false,
        continuous_meeting_chat: { enable: false },
      },
    });
  });

  it("scheduled room uses UTC and never carries invitees, hosts or schedule_for", () => {
    const body = roomRequestBody({ topic: "Dana", start: "2026-10-17T10:00:00-06:00", durationMin: 45 });
    expect(body).toMatchObject({ type: 2, start_time: "2026-10-17T16:00:00Z", timezone: "UTC", duration: 45 });
    const raw = JSON.stringify(body);
    for (const k of ["meeting_invitees", "invitees", "schedule_for", '"registrants"', "contact_email", "authentication_exception", "global_dial_in"]) {
      expect(raw).not.toContain(k);
    }
  });

  it("join links must be https on zoom.us", () => {
    expect(isZoomJoinUrl("https://us02web.zoom.us/j/123?pwd=x")).toBe(true);
    expect(isZoomJoinUrl("https://zoom.us/j/1")).toBe(true);
    for (const bad of ["http://zoom.us/j/1", "https://zoom.us.evil.example/j/1", "https://evilzoom.us/j/1", "https://u:p@zoom.us/j/1", "https://zoom.us:8443/j/1", "zoommtg://zoom.us/join", "nope"]) {
      expect(isZoomJoinUrl(bad), bad).toBe(false);
    }
  });
});

describe("ZoomMeetings", () => {
  const auth = () => ({ accessToken: vi.fn(async () => "at-1"), invalidate: vi.fn() });
  const created = { id: 85012345678, join_url: "https://us02web.zoom.us/j/85012345678?pwd=abc", password: "Xy12", start_url: "https://us02web.zoom.us/s/85012345678?zak=HOSTTOKEN", start_time: "2026-10-17T16:00:00Z" };

  it("POSTs the fixed body to /users/me/meetings and never returns the host start_url", async () => {
    const f = fakeFetch(() => json(201, created));
    const room = await new ZoomMeetings(auth(), f.fn).create({ topic: "Dana", start: "2026-10-17T16:00:00Z" });
    expect(room).toEqual({ meetingId: "85012345678", joinUrl: created.join_url, passcode: "Xy12", start: "2026-10-17T16:00:00Z" });
    expect(JSON.stringify(room)).not.toContain("HOSTTOKEN");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://api.zoom.us/v2/users/me/meetings");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer at-1");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual(roomRequestBody({ topic: "Dana", start: "2026-10-17T16:00:00Z" }));
  });

  it("retries once with a fresh token on 401, and never retries other failures", async () => {
    let n = 0;
    const a = { accessToken: vi.fn(async () => `at-${++n}`), invalidate: vi.fn() };
    const f = fakeFetch((_u, _i, n) => (n === 1 ? json(401, { code: 124 }) : json(201, created)));
    await new ZoomMeetings(a, f.fn).create({ topic: "x" });
    expect(a.invalidate).toHaveBeenCalledOnce();
    expect(f.calls.map((c) => (c.init.headers as Record<string, string>).Authorization)).toEqual(["Bearer at-1", "Bearer at-2"]);

    const twice = fakeFetch(() => json(401, {}));
    await expect(new ZoomMeetings(auth(), twice.fn).create({ topic: "x" })).rejects.toThrow(/permission denied/);
    expect(twice.calls).toHaveLength(2);

    const f500 = fakeFetch(() => json(500, {}));
    await expect(new ZoomMeetings(auth(), f500.fn).create({ topic: "x" })).rejects.toThrow(/HTTP 500/);
    expect(f500.calls).toHaveLength(1);

    const f429 = fakeFetch(() => json(429, {}));
    await expect(new ZoomMeetings(auth(), f429.fn).create({ topic: "x" })).rejects.toThrow(/rate-limiting/);
  });

  it("a timeout is reported as 'may have been created' and never retried", async () => {
    const f = fakeFetch(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(new ZoomMeetings(auth(), f.fn).create({ topic: "x" })).rejects.toThrow(/may still have been created/);
    expect(f.calls).toHaveLength(1);
  });

  it("rejects a join link that isn't on zoom.us, or a malformed response", async () => {
    const evil = fakeFetch(() => json(201, { ...created, join_url: "https://zoom.example/j/1" }));
    await expect(new ZoomMeetings(auth(), evil.fn).create({ topic: "x" })).rejects.toBeInstanceOf(ZoomApiError);
    const junk = fakeFetch(() => json(201, { nope: true }));
    await expect(new ZoomMeetings(auth(), junk.fn).create({ topic: "x" })).rejects.toThrow(/unexpected/);
  });
});

describe("ZoomAuth", () => {
  it("builds a PKCE authorize URL", () => {
    const u = new URL(new ZoomAuth(CFG, stableStore()).authorizeUrl({ state: "st", codeChallenge: "ch" }));
    expect(u.origin + u.pathname).toBe("https://zoom.us/oauth/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: "code",
      client_id: "cid",
      redirect_uri: CFG.redirectUri,
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
  });

  it("exchanges a code with the verifier and stores the refresh token encrypted", async () => {
    const s = stableStore();
    const f = fakeFetch(() => json(200, { access_token: "at-0", refresh_token: "rt-0", expires_in: 3600, scope: ZOOM_MEETING_SCOPE }));
    const a = new ZoomAuth(CFG, s, f.fn, () => NOW.getTime());
    await a.exchangeCode("code-1", "verifier-1", NOW.toISOString());
    expect(Object.fromEntries(form(f.calls[0]!))).toEqual({ grant_type: "authorization_code", code: "code-1", redirect_uri: CFG.redirectUri, code_verifier: "verifier-1" });
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("cid:csecret").toString("base64")}`);
    expect(await s.load("zoom")).toMatchObject({ secret: "rt-0", secretKind: "refresh_token", grantedScopes: [ZOOM_MEETING_SCOPE], status: "connected" });
    expect(await kvOf(s).get("t:conn:zoom:tokens")).not.toContain("rt-0");
    expect(await a.accessToken()).toBe("at-0"); // cached, no refresh
    expect(f.calls).toHaveLength(1);
  });

  it("not connected → ZoomNotConnectedError, no network", async () => {
    const f = fakeFetch(() => json(200, {}));
    await expect(new ZoomAuth(CFG, stableStore(), f.fn).accessToken()).rejects.toBeInstanceOf(ZoomNotConnectedError);
    expect(f.calls).toHaveLength(0);
  });

  it("saves Zoom's rotated refresh token before using the access token, and caches it", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    const f = fakeFetch(() => json(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600, scope: ZOOM_MEETING_SCOPE }));
    const a = new ZoomAuth(CFG, s, f.fn, () => NOW.getTime());
    expect(await a.accessToken()).toBe("at-2");
    expect(form(f.calls[0]!).get("refresh_token")).toBe("rt-1");
    expect((await s.load("zoom"))?.secret).toBe("rt-2");
    expect(await a.accessToken()).toBe("at-2");
    expect(f.calls).toHaveLength(1);
  });

  it("concurrent callers share one refresh", async () => {
    const s = stableStore();
    await connect(s);
    const f = fakeFetch(() => json(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 }));
    const a = new ZoomAuth(CFG, s, f.fn, () => NOW.getTime());
    expect(await Promise.all([a.accessToken(), a.accessToken(), a.accessToken()])).toEqual(["at-2", "at-2", "at-2"]);
    expect(f.calls).toHaveLength(1);
  });

  it("refreshes again after expiry and after a reconnect", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    let t = NOW.getTime();
    let n = 0;
    const f = fakeFetch(() => {
      n += 1;
      return json(200, { access_token: `at-${n}`, refresh_token: `rt-x${n}`, expires_in: 3600 });
    });
    const a = new ZoomAuth(CFG, s, f.fn, () => t);
    expect(await a.accessToken()).toBe("at-1");
    t += 3600_000; // expired
    expect(await a.accessToken()).toBe("at-2");
    await connect(s, "rt-new", [ZOOM_MEETING_SCOPE], "2026-10-16T16:00:00.000Z"); // owner reconnected: cached token is the old grant
    expect(await a.accessToken()).toBe("at-3");
    expect(form(f.calls[2]!).get("refresh_token")).toBe("rt-new");
  });

  it("a dead refresh token → ReauthRequiredError; client misconfig is not reauth", async () => {
    const s = stableStore();
    await connect(s);
    const dead = fakeFetch(() => json(400, { reason: "Invalid Token!", error: "invalid_request" }));
    await expect(new ZoomAuth(CFG, s, dead.fn).accessToken()).rejects.toBeInstanceOf(ReauthRequiredError);
    const misconfig = fakeFetch(() => json(401, { reason: "Invalid client_id or client_secret", error: "invalid_client" }));
    const err = await new ZoomAuth(CFG, s, misconfig.fn).accessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZoomAuthError);
    expect(String((err as Error).message)).not.toContain("client_secret");
  });

  it("retries once with a token another instance rotated in the meantime", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    const f = fakeFetch(async (_u, init, n) => {
      if (n === 1) {
        await rotateElsewhere(s, "rt-2"); // the other instance's rotation lands while our request is in flight
        return json(400, { error: "invalid_grant" });
      }
      expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe("rt-2");
      return json(200, { access_token: "at-3", refresh_token: "rt-3", expires_in: 3600 });
    });
    expect(await new ZoomAuth(CFG, s, f.fn).accessToken()).toBe("at-3");
    expect((await s.load("zoom"))?.secret).toBe("rt-3");
  });

  it("keeps a cached access token when another instance rotates the refresh token", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    const f = fakeFetch(() => json(200, { access_token: "at-1", refresh_token: "rt-2", expires_in: 3600 }));
    const a = new ZoomAuth(CFG, s, f.fn, () => NOW.getTime());
    await a.accessToken();
    await rotateElsewhere(s, "rt-9");
    expect(await a.accessToken()).toBe("at-1");
    expect(f.calls).toHaveLength(1);
  });

  it("serialises refreshes across instances with the KV lock, each using the latest token", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    const lock = new KvRefreshLock(kvOf(s), "t:conn:zoom:refresh-lock", { pollMs: 1 });
    const live = new Set(["rt-1"]); // Zoom: a used refresh token stops working
    let n = 0;
    const f = fakeFetch(async (_u, init) => {
      const rt = new URLSearchParams(String(init.body)).get("refresh_token")!;
      await new Promise((r) => setTimeout(r, 5));
      if (!live.delete(rt)) return json(400, { error: "invalid_request" });
      n += 1;
      live.add(`rt-${n + 1}`);
      return json(200, { access_token: `at-${n}`, refresh_token: `rt-${n + 1}`, expires_in: 3600 });
    });
    const instances = [0, 1, 2].map(() => new ZoomAuth(CFG, s, f.fn, () => NOW.getTime(), lock));
    const tokens = await Promise.all(instances.map((a) => a.accessToken()));
    expect(new Set(tokens).size).toBe(3);
    expect((await s.load("zoom"))?.secret).toBe("rt-4");
    expect((await s.load("zoom"))?.status).toBe("connected");
    expect(await kvOf(s).get("t:conn:zoom:refresh-lock")).toBeNull();
  });

  it("a valid refresh clears a needs_reauth set by a racing instance", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    await s.markNeedsReauth("zoom", "race", "rt-1");
    const f = fakeFetch(() => json(200, { access_token: "at-1", refresh_token: "rt-2", expires_in: 3600 }));
    await new ZoomAuth(CFG, s, f.fn).accessToken();
    const v = await s.load("zoom");
    expect(v).toMatchObject({ secret: "rt-2", status: "connected" });
    expect(v?.lastError).toBeUndefined();
  });

  it("retries a failed save, then keeps the rotated token in memory for the next refresh", async () => {
    const s = stableStore();
    await connect(s, "rt-1");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const update = vi.spyOn(s, "update").mockRejectedValue(new Error("KV down"));
    let t = NOW.getTime();
    let n = 0;
    const f = fakeFetch(() => {
      n += 1;
      return json(200, { access_token: `at-${n}`, refresh_token: `rt-${n + 1}`, expires_in: 3600 });
    });
    const a = new ZoomAuth(CFG, s, f.fn, () => t, undefined, 0);
    expect(await a.accessToken()).toBe("at-1"); // still usable
    expect(update).toHaveBeenCalledTimes(3);
    update.mockRestore();
    t += 3600_000;
    expect(await a.accessToken()).toBe("at-2");
    expect(form(f.calls[1]!).get("refresh_token")).toBe("rt-2"); // not the dead stored rt-1
    expect((await s.load("zoom"))?.secret).toBe("rt-3");
    err.mockRestore();
  });

  it("is configured only with both client id and secret", () => {
    expect(zoomConfigFromEnv("https://b.example")).toBeNull();
    process.env.ZOOM_CLIENT_ID = "id";
    expect(zoomConfigFromEnv("https://b.example")).toBeNull();
    process.env.ZOOM_CLIENT_SECRET = "sec";
    expect(zoomConfigFromEnv("https://b.example")).toEqual({ clientId: "id", clientSecret: "sec", redirectUri: "https://b.example/api/connections/zoom/callback" });
    process.env.ZOOM_REDIRECT_URI = "https://other.example/cb";
    expect(zoomConfigFromEnv("https://b.example")?.redirectUri).toBe("https://other.example/cb");
  });
});

describe("video.create_room through invokeCapability", () => {
  it("runs for owner requests and audits the arguments (Zoom is not first-party)", async () => {
    const deps = makeDeps({ now: NOW, zoom: true });
    const room = await invokeCapability(deps, "video.create_room", { topic: "Sync with Dana", durationMin: 45 }, { caller: "ask", device: "watch" });
    expect(room.joinUrl).toMatch(/^https:\/\/us02web\.zoom\.us\//);
    const [row] = await deps.repos.audit.recent();
    expect(row).toMatchObject({ connector: "zoom", capability: "video.create_room", tier: "auto", caller: "ask", device: "watch", ok: true });
    expect(row?.summary).toContain("Sync with Dana");
    expect(row?.args).toContain("45");
  });

  it("background callers cannot create rooms", async () => {
    const deps = makeDeps({ now: NOW, zoom: true });
    for (const caller of ["cron", "brief"] as const) {
      await expect(invokeCapability(deps, "video.create_room", { topic: "x" }, { caller })).rejects.toBeInstanceOf(CapabilityDeniedError);
    }
    expect(deps.zoom.created).toEqual([]);
  });

  it("validates input and strips anything that could invite people", async () => {
    const deps = makeDeps({ now: NOW, zoom: true });
    await expect(invokeCapability(deps, "video.create_room", { topic: "x", durationMin: 999 }, { caller: "ask" })).rejects.toThrow(/invalid input/);
    await expect(invokeCapability(deps, "video.create_room", { topic: "x", start: "tomorrow" }, { caller: "ask" })).rejects.toThrow(/invalid input/);
    await expect(invokeCapability(deps, "video.create_room", { topic: "" }, { caller: "ask" })).rejects.toThrow(/invalid input/);
    await invokeCapability(deps, "video.create_room", { topic: "x", meeting_invitees: [{ email: "a@b.co" }], alternative_hosts: "a@b.co" }, { caller: "ask" });
    expect(deps.zoom.created).toEqual([{ topic: "x" }]);
  });

  it("a revoked Zoom sign-in marks the connection needs_reauth", async () => {
    const deps = makeDeps({ now: NOW, zoom: true });
    await connect(deps.connections, "rt-1");
    deps.zoom.error = new ReauthRequiredError("zoom", "Zoom rejected the stored sign-in.");
    await expect(invokeCapability(deps, "video.create_room", { topic: "x" }, { caller: "ask" })).rejects.toBeInstanceOf(ReauthRequiredError);
    expect((await deps.connections.load("zoom"))?.status).toBe("needs_reauth");
    deps.zoom.error = null;
    await expect(invokeCapability(deps, "video.create_room", { topic: "x" }, { caller: "ask" })).rejects.toBeInstanceOf(ConnectionUnusableError);
  });

  it("end to end: a dead Zoom refresh token marks needs_reauth with no room created", async () => {
    const deps = makeDeps({ now: NOW });
    await connect(deps.connections, "rt-1");
    const f = fakeFetch((url) => (url.includes("/oauth/token") ? json(400, { reason: "Invalid Token!", error: "invalid_request" }) : json(201, {})));
    const zoomAuth = new ZoomAuth(CFG, deps.connections, f.fn);
    const real = { ...deps, connectors: () => [new ZoomConnector(async () => new ZoomMeetings(zoomAuth, f.fn))] };
    await expect(invokeCapability(real, "video.create_room", { topic: "x" }, { caller: "ask" })).rejects.toBeInstanceOf(ReauthRequiredError);
    expect((await deps.connections.load("zoom"))?.status).toBe("needs_reauth");
    expect(f.calls.some((c) => c.url.includes("/meetings"))).toBe(false);
  });

  it("is disabled when Zoom didn't grant the meeting scope", async () => {
    const deps = makeDeps({ now: NOW, zoom: true });
    await connect(deps.connections, "rt-1", ["user:read:user"]);
    await expect(invokeCapability(deps, "video.create_room", { topic: "x" }, { caller: "ask" })).rejects.toBeInstanceOf(ConnectionUnusableError);
    expect(deps.zoom.created).toEqual([]);
  });

  it("the connector asks only for the granular meeting scope", () => {
    const z = new ZoomConnector(async () => {
      throw new Error("unused");
    });
    expect(z.scopesFor(["video.create_room"])).toEqual([ZOOM_MEETING_SCOPE]);
    expect(z.scopesFor(["email.read"])).toEqual([]);
    expect(z.capabilities).toEqual(["video.create_room"]);
  });
});

describe("start_video_room tool", () => {
  async function run(input: unknown, opts: { zoom?: boolean } = {}) {
    let toolResult: { content: string; is_error?: boolean } | undefined;
    const llm = new ScriptedLLM([
      () => msg([toolUse("start_video_room", input)]),
      (p) => {
        toolResult = (p.messages.at(-1)!.content as { content: string; is_error?: boolean }[])[0];
        return msg([toolUse("respond", { reply: "Room ready.", spoken: "Your Zoom room is ready." })]);
      },
    ]);
    const deps = makeDeps({ llm, now: NOW, zoom: opts.zoom ?? true });
    setDeps(deps);
    const { token } = await pairDevice(deps, "glasses");
    const res = await ask(req("POST", "/api/ask", { token, body: { text: "start a zoom", device: "glasses" } }), params({}));
    expect(res.status).toBe(200);
    return { deps, toolResult: toolResult! };
  }

  it("creates an instant room, returns the join link, sends nothing", async () => {
    const { deps, toolResult } = await run({ topic: "Quick sync" });
    expect(toolResult.is_error).toBeFalsy();
    expect(JSON.parse(toolResult.content)).toMatchObject({ joinUrl: expect.stringMatching(/zoom\.us/), note: expect.stringMatching(/Nobody was invited/) });
    expect(deps.zoom.created).toEqual([{ topic: "Quick sync" }]);
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    expect(deps.ws.createDraft).not.toHaveBeenCalled();
  });

  it("reads a zone-less start in the owner's time zone", async () => {
    const { deps } = await run({ topic: "Dana", start: "2026-10-17T10:00", durationMin: 60 });
    expect(deps.zoom.created).toEqual([{ topic: "Dana", start: "2026-10-17T16:00:00.000Z", durationMin: 60 }]);
  });

  it("refuses a past, far-future, date-only or non-ISO start", async () => {
    for (const start of ["2026-10-01T10:00:00Z", "2026-10-17", "2028-01-01T10:00:00Z", "Oct 17 2026 10:00"]) {
      const { deps, toolResult } = await run({ topic: "x", start });
      expect(toolResult.is_error).toBe(true);
      expect(deps.zoom.created).toEqual([]);
    }
  });

  it("says Zoom is unavailable when it isn't configured", async () => {
    const { toolResult } = await run({ topic: "x" }, { zoom: false });
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toMatch(/video\.create_room/);
  });
});
