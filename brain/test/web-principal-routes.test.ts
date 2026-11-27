import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAsk } from "@/lib/assistant/ask";
import { setDeps } from "@/lib/deps";
import { SESSION_COOKIE, signSession } from "@/lib/dashboard/session";
import { DASHBOARD_DEVICE_NAME } from "@/lib/dashboard/device-bridge";
import { framesToWav } from "@/lib/talk/audio";
import { middleware } from "@/middleware";
import { POST as ask } from "@/app/api/ask/route";
import { POST as transcribe } from "@/app/api/transcribe/route";
import { POST as speak } from "@/app/api/speak/route";
import { GET as listCommitments } from "@/app/api/commitments/route";
import { POST as complete } from "@/app/api/commitments/[id]/complete/route";
import { makeDeps, msg, NO_PARAMS, pairDevice, params, req, ScriptedLLM, toolUse, type TestDeps } from "./fakes";

/**
 * Web app slice 2c-ii-a (docs/WEBAPP.md §4.2): /api/ask, /api/transcribe, /api/speak and the
 * commitments routes accept the dashboard session (withPrincipal) as the owner's `web` device,
 * with the same fail-closed CSRF check as the drafts routes. Device tokens work as before.
 */

// Call through to the real runAsk, but record what the route passed as the authenticated device.
vi.mock("@/lib/assistant/ask", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/assistant/ask")>();
  return { ...real, runAsk: vi.fn(real.runAsk) };
});

const SESSION_SECRET = "test-session-secret-0123456789abcdef";
const KEY = randomBytes(32);
const SAME = { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" };
const CROSS: Record<string, string>[] = [
  {},
  { "sec-fetch-site": "cross-site" },
  { "sec-fetch-site": "same-site" },
  { origin: "https://evil.example" },
  { origin: "null" },
  { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
  { origin: "http://localhost:3000", "sec-fetch-site": "cross-site" },
];

beforeEach(() => {
  vi.mocked(runAsk).mockClear();
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

function wav(): Uint8Array {
  const n = 16_000;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / 16_000);
  return framesToWav([f], 16_000);
}

function setup(llm = new ScriptedLLM([() => msg([toolUse("respond", { reply: "Two meetings today.", spoken: "Two meetings today." })])])) {
  const heard: Uint8Array[] = [];
  const spokenTexts: string[] = [];
  const deps = makeDeps({
    llm,
    transcriber: { name: "fake", transcribe: async (a: Uint8Array) => (heard.push(a), "what's on today") },
    tts: {
      name: "fake",
      synthesize: async (text: string) => {
        spokenTexts.push(text);
        const { pcm16ToWav } = await import("@/lib/tts");
        return { wav: pcm16ToWav(new Uint8Array(4_800), 24_000), sampleRate: 24_000 };
      },
    },
  });
  setDeps(deps);
  return { deps, llm, heard, spokenTexts };
}

function wavReq(headers: Record<string, string>, body = wav()): NextRequest {
  return req("POST", "/api/transcribe", { headers: { "content-type": "audio/wav", ...headers }, raw: body as BodyInit });
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code;
}

async function addCommitment(deps: TestDeps): Promise<string> {
  const { commitment } = await deps.repos.commitments.add({ who: "Stimmel", what: "Send pricing", dueAt: "2026-10-23", source: { kind: "voice" }, confidence: "CONFIRMED" });
  return commitment.id;
}

describe("session principal on /api/ask", () => {
  it("asks as the owner's web device with a same-origin session", async () => {
    const { deps, llm } = setup();
    const res = await ask(req("POST", "/api/ask", { headers: { cookie: await cookie(), ...SAME }, body: { text: "what's on today", device: "web" } }), NO_PARAMS);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reply: "Two meetings today.", spoken: "Two meetings today." });
    expect(llm.calls).toHaveLength(1);
    const web = (await deps.repos.devices.list()).filter((d) => !d.revoked);
    expect(web).toHaveLength(1);
    expect(web[0]).toMatchObject({ kind: "web", name: DASHBOARD_DEVICE_NAME });
    // The tools run as that device: the route passes its real id and kind to runAsk.
    expect(vi.mocked(runAsk)).toHaveBeenCalledOnce();
    expect(vi.mocked(runAsk).mock.calls[0]![2]).toEqual({ deviceId: web[0]!.id, deviceKind: "web" });
  });

  it("a session can only ask as web: any other body device is 400 device_mismatch and Claude is never called", async () => {
    const { llm } = setup();
    const c = await cookie();
    for (const device of ["phone", "medallion", "glasses", "watch", "reachy"]) {
      const res = await ask(req("POST", "/api/ask", { headers: { cookie: c, ...SAME }, body: { text: "hi", device } }), NO_PARAMS);
      expect(res.status, device).toBe(400);
      expect(await codeOf(res)).toBe("device_mismatch");
    }
    expect(llm.calls).toHaveLength(0);
  });

  it("fail-closed CSRF: missing or cross-site headers are 403 and Claude is never called", async () => {
    const { llm } = setup();
    const c = await cookie();
    for (const h of CROSS) {
      const res = await ask(req("POST", "/api/ask", { headers: { cookie: c, ...h }, body: { text: "hi", device: "web" } }), NO_PARAMS);
      expect(res.status, JSON.stringify(h)).toBe(403);
      expect(await codeOf(res)).toBe("cross_site");
    }
    expect(llm.calls).toHaveLength(0);
  });

  it("no credential, a forged cookie, or a bad Authorization header next to a valid cookie: 401", async () => {
    const { llm } = setup();
    const forged = await cookie("another-secret-that-is-long-enough-0000");
    for (const headers of [SAME, { cookie: forged, ...SAME }, { cookie: await cookie(), authorization: "Bearer nope", ...SAME }, { cookie: await cookie(), authorization: "Basic eA==", ...SAME }]) {
      const res = await ask(req("POST", "/api/ask", { headers, body: { text: "hi", device: "web" } }), NO_PARAMS);
      expect(res.status, JSON.stringify(headers)).toBe(401);
    }
    expect(llm.calls).toHaveLength(0);
  });

  it("device tokens work as before, and the phone may still relay for its medallion", async () => {
    const { deps } = setup();
    const { token } = await pairDevice(deps, "phone");
    const res = await ask(req("POST", "/api/ask", { token, headers: { cookie: await cookie() }, body: { text: "hi", device: "medallion" } }), NO_PARAMS);
    expect(res.status).toBe(200);
    expect(vi.mocked(runAsk).mock.calls[0]![2]).toMatchObject({ deviceKind: "phone" });
    // No session device was minted: the cookie is ignored when a bearer token is sent.
    expect((await deps.repos.devices.list()).some((d) => d.kind === "web")).toBe(false);
    const { token: watch } = await pairDevice(deps, "watch");
    expect((await ask(req("POST", "/api/ask", { token: watch, body: { text: "hi", device: "web" } }), NO_PARAMS)).status).toBe(400);
  });
});

describe("session principal on /api/transcribe and /api/speak", () => {
  it("transcribes a same-origin session upload unchanged", async () => {
    const { heard } = setup();
    const audio = wav();
    const res = await transcribe(wavReq({ cookie: await cookie(), ...SAME }, audio), NO_PARAMS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "what's on today" });
    expect(heard).toHaveLength(1);
    expect(Buffer.from(heard[0]!).equals(Buffer.from(audio))).toBe(true);
  });

  it("transcribe: CSRF and auth failures never reach the provider", async () => {
    const { heard } = setup();
    const c = await cookie();
    for (const h of CROSS) expect((await transcribe(wavReq({ cookie: c, ...h }), NO_PARAMS)).status, JSON.stringify(h)).toBe(403);
    expect((await transcribe(wavReq(SAME), NO_PARAMS)).status).toBe(401);
    expect(heard).toHaveLength(0);
  });

  it("transcribe still enforces its limits for a session (415, 413, 422)", async () => {
    const { heard } = setup();
    const c = await cookie();
    const wrongType = req("POST", "/api/transcribe", { headers: { cookie: c, ...SAME, "content-type": "audio/webm" }, raw: wav() as BodyInit });
    expect((await transcribe(wrongType, NO_PARAMS)).status).toBe(415);
    const tooBig = req("POST", "/api/transcribe", { headers: { cookie: c, ...SAME, "content-type": "audio/wav", "content-length": String(16_000 * 2 * 121) }, raw: wav() as BodyInit });
    expect((await transcribe(tooBig, NO_PARAMS)).status).toBe(413);
    expect((await transcribe(wavReq({ cookie: c, ...SAME }, new Uint8Array([1, 2, 3])), NO_PARAMS)).status).toBe(422);
    expect(heard).toHaveLength(0);
  });

  it("speaks for a same-origin session; CSRF and auth failures never reach the provider", async () => {
    const { spokenTexts } = setup();
    const c = await cookie();
    const ok = await speak(req("POST", "/api/speak", { headers: { cookie: c, ...SAME }, body: { text: "Two meetings today." } }), NO_PARAMS);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("audio/wav");
    for (const h of CROSS) expect((await speak(req("POST", "/api/speak", { headers: { cookie: c, ...h }, body: { text: "x" } }), NO_PARAMS)).status, JSON.stringify(h)).toBe(403);
    expect((await speak(req("POST", "/api/speak", { headers: SAME, body: { text: "x" } }), NO_PARAMS)).status).toBe(401);
    expect(spokenTexts).toEqual(["Two meetings today."]);
  });
});

describe("session principal on the commitments routes", () => {
  it("GET /api/commitments works with the cookie alone (a GET needs no same-origin headers)", async () => {
    const { deps } = setup();
    const id = await addCommitment(deps);
    const res = await listCommitments(req("GET", "/api/commitments?status=all", { headers: { cookie: await cookie() } }), NO_PARAMS);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([id]);
    expect((await listCommitments(req("GET", "/api/commitments", {}), NO_PARAMS)).status).toBe(401);
  });

  it("complete needs a same-origin session; refused requests leave the commitment open", async () => {
    const { deps } = setup();
    const id = await addCommitment(deps);
    const c = await cookie();
    for (const h of CROSS) {
      const res = await complete(req("POST", "/x", { headers: { cookie: c, ...h } }), params({ id }));
      expect(res.status, JSON.stringify(h)).toBe(403);
    }
    expect((await deps.repos.commitments.list("all")).find((x) => x.id === id)?.status).not.toBe("done");
    const ok = await complete(req("POST", "/x", { headers: { cookie: c, ...SAME } }), params({ id }));
    expect(ok.status).toBe(200);
    expect((await deps.repos.commitments.list("all")).find((x) => x.id === id)?.status).toBe("done");
    expect((await complete(req("POST", "/x", { headers: { cookie: c, ...SAME } }), params({ id: "cmt_missing" }))).status).toBe(404);
  });

  it("a device token completes as before", async () => {
    const { deps } = setup();
    const id = await addCommitment(deps);
    const { token } = await pairDevice(deps, "watch");
    expect((await complete(req("POST", "/x", { token }), params({ id }))).status).toBe(200);
  });
});

describe("middleware: the session cookie reaches the new withPrincipal routes only", () => {
  it("lets the cookie through to ask/transcribe/speak/commitments, and nothing near them", async () => {
    const value = (await signSession(SESSION_SECRET)).value;
    const mk = (path: string, withCookie: boolean, method = "POST") => {
      const headers = new Headers();
      if (withCookie) headers.set("cookie", `${SESSION_COOKIE}=${value}`);
      return new NextRequest(new URL(path, "https://brain.example"), { method, headers });
    };
    const passes = async (r: NextRequest) => (await middleware(r)).headers.get("x-middleware-next") === "1";
    for (const p of ["/api/ask", "/api/transcribe", "/api/speak", "/api/commitments/cmt_abc123/complete"]) {
      expect(await passes(mk(p, true)), p).toBe(true);
      expect((await middleware(mk(p, true))).headers.get("cache-control"), p).toBe("no-store");
      expect((await middleware(mk(p, false))).status, p).toBe(401);
    }
    expect(await passes(mk("/api/commitments", true, "GET"))).toBe(true);
    for (const p of [
      "/api/ask/x",
      "/api/asks",
      "/api/speak/",
      "/api/transcribe/x",
      "/api/commitments/cmt_abc123",
      "/api/commitments/a.b/complete",
      "/api/commitments/cmt_abc123/complete/x",
      "/api/commands/cmd_1",
      "/api/commands/cmd_1/ack/x",
      "/api/top5",
      "/api/brief",
      "/api/alerts",
      "/api/followups",
      "/api/devices/register",
      "/api/devices/pair-code",
      "/api/connector-requests",
    ]) {
      expect((await middleware(mk(p, true))).status, p).toBe(401);
    }
  });
});
