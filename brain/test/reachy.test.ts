import { describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import { makeDeps, msg, pairDevice, params, req, ScriptedLLM, toolUse } from "./fakes";
import { GET as alertsRoute } from "@/app/api/alerts/route";
import { POST as speakRoute } from "@/app/api/speak/route";
import { GET as scan } from "@/app/api/cron/scan/route";
import { POST as pair } from "@/app/api/devices/pair/route";
import { deliverAlert } from "@/lib/push/alerts";
import { OpenAISpeechSynthesizer, pcm16ToWav, SpeechError, speechSynthesizerFromEnv } from "@/lib/tts";
import { parseWav } from "@/lib/transcribe/wav";
import { AlertsResponseSchema, DEVICE_KINDS } from "@/lib/models";
import type { AlertsResponse } from "@/lib/models";

async function getAlerts(token: string, query = ""): Promise<{ status: number; body: AlertsResponse }> {
  const res = await alertsRoute(req("GET", `/api/alerts${query}`, { token }), params({}));
  return { status: res.status, body: (await res.json()) as AlertsResponse };
}

describe("device kind reachy", () => {
  it("is in the contract and can pair", async () => {
    expect(DEVICE_KINDS).toContain("reachy");
    const deps = makeDeps();
    setDeps(deps);
    const { code } = await deps.repos.pairing.issue(600, "Desk robot");
    const res = await pair(req("POST", "/api/devices/pair", { body: { code, device: "reachy" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ device: "reachy" });
  });
});

describe("GET /api/alerts", () => {
  it("requires a device token", async () => {
    setDeps(makeDeps());
    const res = await alertsRoute(req("GET", "/api/alerts"), params({}));
    expect(res.status).toBe(401);
  });

  it("returns alerts with the same content as the FCM push, and a cursor", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const { token } = await pairDevice(deps, "reachy");
    await deps.repos.devices.create("phone").then(({ device }) => deps.repos.devices.setFcmToken(device.id, "fcm-1", "phone"));

    const pushed = { title: "Critical: Dana Lee", body: "ACME deposit bounced", data: { kind: "email", importance: "CRITICAL", messageId: "m1", threadId: "t1", client: "ACME" }, priority: "high" as const };
    expect(await deliverAlert(deps, pushed)).toBe(1);

    const first = await getAlerts(token);
    expect(first.status).toBe(200);
    expect(AlertsResponseSchema.parse(first.body)).toBeTruthy();
    expect(first.body.items).toHaveLength(1);
    const a = first.body.items[0]!;
    const fcm = deps.pushFake.sent[0]!.msg;
    expect({ title: a.title, body: a.body }).toEqual({ title: fcm.title, body: fcm.body });
    expect(a).toMatchObject({ kind: fcm.data!.kind, importance: fcm.data!.importance, messageId: "m1", threadId: "t1", client: "ACME", priority: "high" });
    expect(first.body.more).toBe(false);

    // Nothing new since the cursor.
    const again = await getAlerts(token, `?since=${first.body.cursor}`);
    expect(again.body.items).toEqual([]);
    expect(again.body.cursor).toBe(first.body.cursor);

    // A new alert after the cursor is returned once.
    await deliverAlert(deps, { title: "Overdue: your commitment", body: "Send agreement", data: { kind: "commitment_overdue", commitmentId: "c1" } });
    const next = await getAlerts(token, `?since=${again.body.cursor}`);
    expect(next.body.items.map((i) => i.kind)).toEqual(["commitment_overdue"]);
    expect(next.body.items[0]).toMatchObject({ commitmentId: "c1", priority: "normal" });
    expect(Number(next.body.cursor)).toBeGreaterThan(Number(again.body.cursor));
  });

  it("logs alerts even when no device has an FCM token", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const { token } = await pairDevice(deps, "reachy");
    expect(await deliverAlert(deps, { title: "t", body: "b", data: { kind: "email", importance: "HIGH" } })).toBe(1);
    expect(deps.pushFake.sent).toHaveLength(0);
    expect((await getAlerts(token)).body.items).toHaveLength(1);
  });

  it("pages with limit/more, rejects bad cursors, and treats a cursor ahead of the log as fresh", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const { token } = await pairDevice(deps, "reachy");
    for (let i = 0; i < 5; i++) await deliverAlert(deps, { title: `a${i}`, body: "b", data: { kind: "email", importance: "HIGH" } });

    const p1 = await getAlerts(token, "?since=0&limit=2");
    expect(p1.body.items.map((i) => i.title)).toEqual(["a0", "a1"]);
    expect(p1.body.more).toBe(true);
    const p2 = await getAlerts(token, `?since=${p1.body.cursor}&limit=10`);
    expect(p2.body.items.map((i) => i.title)).toEqual(["a2", "a3", "a4"]);
    expect(p2.body.more).toBe(false);

    expect((await getAlerts(token, "?since=abc")).status).toBe(400);
    expect((await getAlerts(token, "?limit=0")).status).toBe(400);
    const ahead = await getAlerts(token, "?since=999");
    expect(ahead.body.items).toHaveLength(5);
    expect(ahead.body.cursor).toBe("5");
  });

  it("without a cursor returns only the last 24 h, and prunes old rows", async () => {
    const deps = makeDeps({ now: new Date("2026-10-10T12:00:00Z") });
    setDeps(deps);
    const { token } = await pairDevice(deps, "reachy");
    await deliverAlert(deps, { title: "old", body: "b", data: { kind: "email" } });
    deps.setNow(new Date("2026-10-16T12:00:00Z"));
    await deliverAlert(deps, { title: "new", body: "b", data: { kind: "email" } });
    expect((await getAlerts(token)).body.items.map((i) => i.title)).toEqual(["new"]);
    expect((await getAlerts(token, "?since=0")).body.items.map((i) => i.title)).toEqual(["old", "new"]);
    deps.setNow(new Date("2026-10-20T12:00:00Z"));
    expect(await deps.repos.alerts.prune()).toBe(1);
    expect((await getAlerts(token, "?since=0")).body.items.map((i) => i.title)).toEqual(["new"]);
  });

  it("the Gmail scan feeds the alert log with the pushed content", async () => {
    const llm = new ScriptedLLM([
      () =>
        msg([
          toolUse("record_email_analysis", {
            summary: "Contract dispute escalated.",
            categories: ["Legal", "Urgent"],
            importance: "CRITICAL",
            client: "ACME",
            people: ["Dana Lee"],
            commitments: [],
            decisions: [],
            followups: [],
            alert: "ACME legal is threatening to cancel the contract.",
          }),
        ]),
    ]);
    const deps = makeDeps({ llm });
    setDeps(deps);
    const { token } = await pairDevice(deps, "reachy");
    await deps.repos.devices.create("phone").then(({ device }) => deps.repos.devices.setFcmToken(device.id, "fcm-1", "phone"));
    deps.ws.messages = [
      { id: "m9", threadId: "t9", from: "Dana Lee <dana@acme.com>", to: "stimmel@example.com", cc: "", subject: "Contract", date: "2026-10-16T14:00:00.000Z", snippet: "", labels: ["INBOX"], body: "We will cancel." },
    ];
    expect((await scan(req("GET", "/api/cron/scan", { token: "test-cron-secret" }))).status).toBe(200);
    const fcm = deps.pushFake.sent[0]!.msg;
    const [alert] = (await getAlerts(token)).body.items;
    expect(alert).toMatchObject({ title: fcm.title, body: fcm.body, kind: "email", importance: "CRITICAL", priority: "high", messageId: "m9", client: "ACME" });
  });
});

describe("POST /api/speak", () => {
  it("returns a playable WAV for a device token", async () => {
    const synth = vi.fn(async (_t: string, _v?: string) => ({ wav: pcm16ToWav(new Uint8Array(48_000), 24_000), sampleRate: 24_000 }));
    const deps = makeDeps({ tts: { name: "fake", synthesize: synth } });
    setDeps(deps);
    const { token } = await pairDevice(deps, "reachy");
    const res = await speakRoute(req("POST", "/api/speak", { token, body: { text: "You have two overdue items.", voice: "nova" } }), params({}));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/wav");
    expect(res.headers.get("x-sample-rate")).toBe("24000");
    const wav = new Uint8Array(await res.arrayBuffer());
    expect(parseWav(wav)).toMatchObject({ sampleRate: 24_000, channels: 1, bitsPerSample: 16, durationSeconds: 1 });
    expect(synth).toHaveBeenCalledWith("You have two overdue items.", "nova");
  });

  it("enforces auth, validation and the length cap", async () => {
    const deps = makeDeps();
    setDeps(deps);
    const { token } = await pairDevice(deps, "reachy");
    expect((await speakRoute(req("POST", "/api/speak", { body: { text: "hi" } }), params({}))).status).toBe(401);
    expect((await speakRoute(req("POST", "/api/speak", { token, body: { text: "   " } }), params({}))).status).toBe(400);
    expect((await speakRoute(req("POST", "/api/speak", { token, body: { text: "hi", voice: "darth" } }), params({}))).status).toBe(400);
    const tooLong = await speakRoute(req("POST", "/api/speak", { token, body: { text: "a".repeat(1001) } }), params({}));
    expect(tooLong.status).toBe(413);
    process.env.SPEAK_MAX_CHARS = "2000";
    expect((await speakRoute(req("POST", "/api/speak", { token, body: { text: "a".repeat(1001) } }), params({}))).status).toBe(200);
    delete process.env.SPEAK_MAX_CHARS;
  });

  it("maps provider failures to 502", async () => {
    const deps = makeDeps({ tts: { name: "x", synthesize: async () => { throw new SpeechError("boom", 500); } } });
    setDeps(deps);
    const { token } = await pairDevice(deps, "reachy");
    const res = await speakRoute(req("POST", "/api/speak", { token, body: { text: "hi" } }), params({}));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "tts_failed" });
  });
});

describe("OpenAI speech synthesizer", () => {
  it("requests pcm from /audio/speech and wraps it as 24 kHz WAV", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(new Uint8Array(2400), { status: 200 }));
    const s = new OpenAISpeechSynthesizer("sk-test", "gpt-4o-mini-tts", "alloy", "https://example.test/v1/", fetchMock as unknown as typeof fetch, "be calm");
    const out = await s.synthesize("hello", "nova");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.test/v1/audio/speech");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init!.body as string)).toEqual({ model: "gpt-4o-mini-tts", input: "hello", voice: "nova", response_format: "pcm", instructions: "be calm" });
    expect(parseWav(out.wav)).toMatchObject({ sampleRate: 24_000, channels: 1, bitsPerSample: 16, dataBytes: 2400 });
  });

  it("surfaces errors and selects provider from env", async () => {
    const s = new OpenAISpeechSynthesizer("k", "tts-1", "alloy", undefined, (async () => new Response("bad", { status: 401 })) as unknown as typeof fetch);
    await expect(s.synthesize("x")).rejects.toBeInstanceOf(SpeechError);
    process.env.OPENAI_API_KEY = "k";
    expect(speechSynthesizerFromEnv().name).toBe("openai");
    process.env.TTS_PROVIDER = "nope";
    expect(() => speechSynthesizerFromEnv()).toThrow(SpeechError);
    delete process.env.TTS_PROVIDER;
    delete process.env.OPENAI_API_KEY;
  });

  it("pcm16ToWav drops an odd trailing byte and preserves samples", () => {
    const pcm = new Uint8Array([0x01, 0x00, 0xff, 0x7f, 0x09]);
    const wav = pcm16ToWav(pcm, 24_000);
    expect(parseWav(wav).dataBytes).toBe(4);
    expect(new DataView(wav.buffer, wav.byteOffset).getInt16(46, true)).toBe(0x7fff);
  });
});
