import { describe, expect, it, vi } from "vitest";
import { setDeps } from "@/lib/deps";
import { DeepgramTranscriber, OpenAIWhisperTranscriber, transcriberFromEnv, TranscriptionError } from "@/lib/transcribe";
import { encodeWav, parseWav } from "@/lib/transcribe/wav";
import { makeDeps, pairDevice, params, req } from "./fakes";
import { POST as transcribe } from "@/app/api/transcribe/route";

const wav = encodeWav(new Int16Array(16000)); // 1 s of silence

describe("WAV validation", () => {
  it("parses a contract WAV", () => {
    expect(parseWav(wav)).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16, durationSeconds: 1 });
  });

  it("route rejects wrong formats and accepts the contract format", async () => {
    const deps = makeDeps({ transcriber: { name: "x", transcribe: async () => "remind me to call Dana" } });
    setDeps(deps);
    const { token } = await pairDevice(deps, "phone");
    const ok = await transcribe(req("POST", "/api/transcribe", { token, raw: wav as BodyInit, headers: { "content-type": "audio/wav" } }), params({}));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ text: "remind me to call Dana" });

    const wrongRate = encodeWav(new Int16Array(44100), 44100);
    expect((await transcribe(req("POST", "/api/transcribe", { token, raw: wrongRate as BodyInit, headers: { "content-type": "audio/wav" } }), params({}))).status).toBe(422);
    expect((await transcribe(req("POST", "/api/transcribe", { token, raw: "hello", headers: { "content-type": "audio/wav" } }), params({}))).status).toBe(422);
    expect((await transcribe(req("POST", "/api/transcribe", { token, raw: wav as BodyInit, headers: { "content-type": "text/plain" } }), params({}))).status).toBe(415);
  });
});

describe("transcribers (fetch mocked)", () => {
  it("OpenAI Whisper posts multipart with bearer key", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ text: " hello " }), { status: 200 }));
    const t = new OpenAIWhisperTranscriber("sk-test", "whisper-1", "https://api.openai.com/v1", "en", fetchMock as unknown as typeof fetch);
    expect(await t.transcribe(wav)).toBe("hello");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const form = init!.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("Deepgram posts raw wav with Token auth and parses transcript", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: "call Dana" }] }] } }), { status: 200 }),
    );
    const t = new DeepgramTranscriber("dg-test", "nova-3", "en", fetchMock as unknown as typeof fetch, ["SideKiqq"]);
    expect(await t.transcribe(wav)).toBe("call Dana");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/api\.deepgram\.com\/v1\/listen\?.*model=nova-3.*keyterm=SideKiqq/);
    expect((init!.headers as Record<string, string>).Authorization).toBe("Token dg-test");
    expect((init!.headers as Record<string, string>)["Content-Type"]).toBe("audio/wav");
  });

  it("surfaces provider errors as TranscriptionError", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    const t = new DeepgramTranscriber("bad", "nova-3", "en", fetchMock as unknown as typeof fetch);
    await expect(t.transcribe(wav)).rejects.toBeInstanceOf(TranscriptionError);
  });

  it("selects provider from env", () => {
    process.env.TRANSCRIBE_PROVIDER = "deepgram";
    process.env.DEEPGRAM_API_KEY = "k";
    expect(transcriberFromEnv().name).toBe("deepgram");
    process.env.TRANSCRIBE_PROVIDER = "openai-whisper";
    process.env.OPENAI_API_KEY = "k";
    expect(transcriberFromEnv().name).toBe("openai-whisper");
    process.env.TRANSCRIBE_PROVIDER = "bogus";
    expect(() => transcriberFromEnv()).toThrow(TranscriptionError);
    delete process.env.TRANSCRIBE_PROVIDER;
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
});
