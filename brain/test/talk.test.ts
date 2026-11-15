import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setDeps } from "@/lib/deps";
import {
  Endpointer,
  MAX_SECONDS,
  MAX_WAV_BYTES,
  TARGET_RATE,
  base64ToBytes,
  bytesToBase64,
  encodeWav,
  floatToPcm16,
  framesToWav,
  resample,
  rms,
} from "@/lib/talk/audio";
import { assertContractWav, parseWav } from "@/lib/transcribe/wav";
import { askFromDashboard, speakFromDashboard, talkFromDashboard } from "@/lib/dashboard/talk";
import { TranscriptionError } from "@/lib/transcribe";
import { SpeechError } from "@/lib/tts";
import { makeDeps, msg, ScriptedLLM, toolUse, type TestDeps } from "./fakes";

/** Web app slice 2b (docs/WEBAPP.md §6): browser tap-to-talk. */

const key = randomBytes(32);

function tone(freq: number, rate: number, seconds: number, amp = 1): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** RMS away from the edges, where the kernel runs off the signal. */
function innerRms(x: Float32Array, margin = 400): number {
  return rms(x.subarray(margin, x.length - margin));
}

describe("resampler", () => {
  it("produces round(n × 16000 / inRate) samples", () => {
    expect(resample(new Float32Array(48_000), 48_000).length).toBe(16_000);
    expect(resample(new Float32Array(44_100), 44_100).length).toBe(16_000);
    expect(resample(new Float32Array(1_001), 48_000).length).toBe(Math.round((1_001 * 16_000) / 48_000));
    expect(resample(new Float32Array(0), 48_000).length).toBe(0);
  });

  it("passes 16 kHz through unchanged (as a copy)", () => {
    const x = tone(440, 16_000, 0.1);
    const y = resample(x, 16_000);
    expect(Array.from(y)).toEqual(Array.from(x));
    expect(y).not.toBe(x);
  });

  for (const rate of [48_000, 44_100, 96_000]) {
    it(`keeps a 1 kHz tone at ${rate} Hz`, () => {
      const y = resample(tone(1_000, rate, 0.5), rate);
      expect(innerRms(y)).toBeGreaterThan(0.69);
      expect(innerRms(y)).toBeLessThan(0.72);
      // Still a 1 kHz sine at 16 kHz: compare against the ideal.
      const ideal = tone(1_000, TARGET_RATE, 0.5);
      let err = 0;
      for (let i = 400; i < y.length - 400; i++) err = Math.max(err, Math.abs(y[i]! - ideal[i]!));
      expect(err).toBeLessThan(0.02);
    });

    it(`attenuates an 11 kHz tone at ${rate} Hz (it would alias to 5 kHz)`, () => {
      const y = resample(tone(11_000, rate, 0.5), rate);
      expect(innerRms(y)).toBeLessThan(0.01);
    });
  }

  it("keeps a constant level (DC gain 1)", () => {
    const y = resample(new Float32Array(4_800).fill(0.5), 48_000);
    for (let i = 50; i < y.length - 50; i++) expect(y[i]).toBeCloseTo(0.5, 4);
  });

  it("refuses silly rates", () => {
    expect(() => resample(new Float32Array(10), 0)).toThrow(RangeError);
    expect(() => resample(new Float32Array(10), Number.NaN)).toThrow(RangeError);
    expect(() => resample(new Float32Array(10), 1_000_000)).toThrow(RangeError);
  });
});

describe("PCM16 + WAV", () => {
  it("converts and clamps floats", () => {
    expect(Array.from(floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5, Number.NaN])))).toEqual([0, 32767, -32768, 32767, -32768, 16384, 0]);
  });

  it("writes the 44-byte header the brain accepts", () => {
    const wav = encodeWav(Int16Array.from([1, -2, 300]));
    expect(wav.byteLength).toBe(44 + 6);
    const text = (o: number) => String.fromCharCode(...wav.subarray(o, o + 4));
    expect(text(0)).toBe("RIFF");
    expect(text(8)).toBe("WAVE");
    expect(text(12)).toBe("fmt ");
    expect(text(36)).toBe("data");
    const v = new DataView(wav.buffer);
    expect(v.getUint32(4, true)).toBe(36 + 6);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint32(28, true)).toBe(32_000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(6);
    expect(v.getInt16(44, true)).toBe(1);
    expect(v.getInt16(46, true)).toBe(-2);
    expect(v.getInt16(48, true)).toBe(300);
    const info = parseWav(wav);
    expect(info).toMatchObject({ audioFormat: 1, channels: 1, sampleRate: 16_000, bitsPerSample: 16, dataBytes: 6 });
    expect(() => assertContractWav(parseWav(encodeWav(new Int16Array(16_000))))).not.toThrow();
  });

  it("framesToWav joins 48 kHz frames into a contract WAV", () => {
    const x = tone(1_000, 48_000, 1);
    const frames: Float32Array[] = [];
    for (let i = 0; i < x.length; i += 128) frames.push(x.slice(i, i + 128));
    const wav = framesToWav(frames, 48_000);
    const info = parseWav(wav);
    assertContractWav(info);
    expect(info.dataBytes).toBe(16_000 * 2);
    expect(info.durationSeconds).toBeCloseTo(1, 5);
  });

  it(`caps an upload at ${MAX_SECONDS} s`, () => {
    const wav = framesToWav([new Float32Array(48_000 * (MAX_SECONDS + 2))], 48_000);
    expect(wav.byteLength).toBe(MAX_WAV_BYTES);
    expect(MAX_WAV_BYTES).toBeLessThan(1024 * 1024); // fits the default 1 MB server action body
  });

  it("base64 round-trips bytes larger than one chunk", () => {
    const b = new Uint8Array(100_000);
    for (let i = 0; i < b.length; i++) b[i] = (i * 31) & 0xff;
    expect(Array.from(base64ToBytes(bytesToBase64(b)))).toEqual(Array.from(b));
  });
});

describe("energy endpointer", () => {
  const rate = 48_000;
  const frame = (amp: number) => new Float32Array(rate / 100).fill(amp); // 10 ms
  const feed = (e: Endpointer, amp: number, ms: number) => {
    let d = "continue";
    for (let t = 0; t < ms; t += 10) {
      d = e.feed(frame(amp), rate);
      if (d !== "continue") return d;
    }
    return d;
  };

  it("stops after 2 s of quiet once there was speech", () => {
    const e = new Endpointer();
    expect(feed(e, 0.2, 500)).toBe("continue");
    expect(e.heardSpeech).toBe(true);
    expect(feed(e, 0.001, 1_900)).toBe("continue");
    expect(feed(e, 0.001, 200)).toBe("silence");
  });

  it("talking again resets the quiet timer", () => {
    const e = new Endpointer();
    feed(e, 0.2, 300);
    expect(feed(e, 0.001, 1_500)).toBe("continue");
    feed(e, 0.2, 100);
    expect(feed(e, 0.001, 1_500)).toBe("continue");
  });

  it("a click is not speech, and 8 s with nothing said gives up", () => {
    const e = new Endpointer();
    feed(e, 0.5, 50);
    expect(e.heardSpeech).toBe(false);
    expect(feed(e, 0.001, 7_800)).toBe("continue");
    expect(feed(e, 0.001, 300)).toBe("no_speech");
  });

  it(`stops at ${MAX_SECONDS} s even while talking, and never allows more`, () => {
    const e = new Endpointer({ maxMs: 999_999 });
    expect(feed(e, 0.2, MAX_SECONDS * 1000 - 100)).toBe("continue");
    expect(feed(e, 0.2, 200)).toBe("max");
  });
});

// ------------------------------------------------------------------------ server side

const WAV_1S = framesToWav([tone(300, 48_000, 1, 0.3)], 48_000);

function setup(opts: { transcript?: string | Error; llm?: ScriptedLLM; tts?: Error } = {}) {
  const heard: Uint8Array[] = [];
  const spokenTexts: string[] = [];
  const deps = makeDeps({
    llm: opts.llm,
    transcriber: {
      name: "fake",
      transcribe: async (audio: Uint8Array) => {
        heard.push(audio);
        if (opts.transcript instanceof Error) throw opts.transcript;
        return opts.transcript ?? "what's on today";
      },
    },
    tts: {
      name: "fake",
      synthesize: async (text: string) => {
        spokenTexts.push(text);
        if (opts.tts) throw opts.tts;
        const { pcm16ToWav } = await import("@/lib/tts");
        return { wav: pcm16ToWav(new Uint8Array(4_800), 24_000), sampleRate: 24_000 };
      },
    },
  });
  setDeps(deps);
  return { deps, heard, spokenTexts };
}

const respond = (reply = "Two meetings today.", spoken = "Two meetings today.") => () => msg([toolUse("respond", { reply, spoken })]);

function systemText(llm: ScriptedLLM, i = 0): string {
  return (llm.calls[i]!.system as { text: string }[]).map((b) => b.text).join("\n");
}

describe("talkFromDashboard: transcribe → ask as web", () => {
  it("uploads the WAV unchanged, asks as the dashboard's web device and returns the reply", async () => {
    const llm = new ScriptedLLM([respond()]);
    const { deps, heard } = setup({ llm });
    const out = await talkFromDashboard(deps, WAV_1S, null, key);
    expect(out).toMatchObject({ ok: true, text: "what's on today", reply: "Two meetings today.", spoken: "Two meetings today.", actions: [] });
    expect(Array.from(heard[0]!)).toEqual(Array.from(WAV_1S));
    expect(systemText(llm)).toContain("Device for this request: web");
    const devices = await deps.repos.devices.list();
    expect(devices.map((d) => d.kind)).toEqual(["web"]);
  });

  it("keeps the conversation going with the returned id, and ignores a malformed one", async () => {
    const llm = new ScriptedLLM([respond("one"), respond("two"), respond("three")]);
    const { deps } = setup({ llm });
    const first = await talkFromDashboard(deps, WAV_1S, null, key);
    if (!first.ok) throw new Error(first.error);
    expect(first.conversationId).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = await talkFromDashboard(deps, WAV_1S, first.conversationId, key);
    expect(second.ok && second.conversationId).toBe(first.conversationId);
    expect(llm.calls[1]!.messages.length).toBeGreaterThan(llm.calls[0]!.messages.length);
    const third = await talkFromDashboard(deps, WAV_1S, "bad id/../x", key);
    expect(third.ok && third.conversationId).not.toBe(first.conversationId);
  });

  it("an empty transcript asks nothing", async () => {
    const llm = new ScriptedLLM([]);
    const { deps } = setup({ llm, transcript: "   " });
    const out = await talkFromDashboard(deps, WAV_1S, null, key);
    expect(out.ok).toBe(false);
    expect(llm.calls).toHaveLength(0);
  });

  it("refuses empty and oversized audio before transcribing", async () => {
    const { deps, heard } = setup({ llm: new ScriptedLLM([]) });
    expect((await talkFromDashboard(deps, encodeWav(new Int16Array(0)), null, key)).ok).toBe(false);
    expect((await talkFromDashboard(deps, new Uint8Array(MAX_WAV_BYTES + 2), null, key)).ok).toBe(false);
    expect(heard).toHaveLength(0);
  });

  it("a non-contract WAV is refused by /api/transcribe with a readable error", async () => {
    const { deps, heard } = setup({ llm: new ScriptedLLM([]) });
    const wrongRate = encodeWav(new Int16Array(4_800), 48_000);
    const out = await talkFromDashboard(deps, wrongRate, null, key);
    expect(out).toEqual({ ok: false, error: "The recording couldn't be read. Try again." });
    expect(heard).toHaveLength(0);
  });

  it("a transcription provider error says so and asks nothing", async () => {
    const llm = new ScriptedLLM([]);
    const { deps } = setup({ llm, transcript: new TranscriptionError("boom", 500) });
    const out = await talkFromDashboard(deps, WAV_1S, null, key);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/Transcription isn't working/);
    expect(llm.calls).toHaveLength(0);
  });

  it("a draft from voice is returned as an action and stays pending: nothing is sent", async () => {
    const llm = new ScriptedLLM([
      () => msg([toolUse("create_email_draft", { to: ["dana@acme.com"], subject: "Running late", body: "Running ten minutes late." })]),
      respond("Draft to dana@acme.com is ready.", "Draft is ready. Tap Send to review it."),
    ]);
    const { deps } = setup({ llm, transcript: "email dana@acme.com that I'm running ten minutes late" });
    const out = await talkFromDashboard(deps, WAV_1S, null, key);
    if (!out.ok) throw new Error(out.error);
    const draftAction = out.actions.find((a) => a.type === "draft_created");
    expect(draftAction).toBeDefined();
    expect(draftAction!.summary).toContain("dana@acme.com");
    const draft = await deps.repos.drafts.get(draftAction!.id);
    expect(draft?.status).toBe("pending");
    expect(deps.sender.sendDraft).not.toHaveBeenCalled();
    expect(deps.inviter.insertInvite).not.toHaveBeenCalled();
  });
});

describe("askFromDashboard (typed)", () => {
  it("asks as web without transcribing", async () => {
    const llm = new ScriptedLLM([respond()]);
    const { deps, heard } = setup({ llm });
    const out = await askFromDashboard(deps, "  what's on today  ", null, key);
    expect(out).toMatchObject({ ok: true, text: "what's on today" });
    expect(heard).toHaveLength(0);
    expect(systemText(llm)).toContain("Device for this request: web");
  });

  it("refuses blank and over-long text without calling the model", async () => {
    const llm = new ScriptedLLM([]);
    const { deps } = setup({ llm });
    expect((await askFromDashboard(deps, "   ", null, key)).ok).toBe(false);
    const long = await askFromDashboard(deps, "x".repeat(8001), null, key);
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.text).toHaveLength(8001); // kept so the owner can shorten it
    expect(llm.calls).toHaveLength(0);
  });
});

describe("speakFromDashboard", () => {
  it("returns the /api/speak WAV as base64", async () => {
    const { deps, spokenTexts } = setup();
    const out = await speakFromDashboard(deps, " Two meetings today. ", key);
    if (!out.ok) throw new Error(out.error);
    const info = parseWav(base64ToBytes(out.wavBase64));
    expect(info.sampleRate).toBe(24_000);
    expect(spokenTexts).toEqual(["Two meetings today."]);
  });

  it("refuses empty or too-long text without calling TTS", async () => {
    const { deps, spokenTexts } = setup();
    expect((await speakFromDashboard(deps, "  ", key)).ok).toBe(false);
    expect((await speakFromDashboard(deps, "x".repeat(5_000), key)).ok).toBe(false);
    expect(spokenTexts).toHaveLength(0);
  });

  it("a TTS failure is an error, not audio", async () => {
    const { deps } = setup({ tts: new SpeechError("down", 503) });
    expect(await speakFromDashboard(deps, "hello", key)).toEqual({ ok: false, error: "The voice reply isn't available right now." });
  });
});

describe("Talk can't send", () => {
  const root = path.resolve(__dirname, "..");
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");

  it("the talk bridge and screen never reach the approve route", () => {
    for (const f of ["src/lib/dashboard/talk.ts", "src/app/(dashboard)/dashboard/talk/TalkPanel.tsx", "src/app/(dashboard)/dashboard/talk/page.tsx"]) {
      const src = read(f);
      expect(src).not.toMatch(/from\s+["'][^"']*(approve|\/api\/drafts)[^"']*["']/);
      expect(src).not.toMatch(/approveDraft|approveRoute|fetch\(/);
    }
  });

  it("the worklet only forwards frames", () => {
    const src = read("public/talk-capture-worklet.js");
    expect(src).not.toMatch(/fetch|XMLHttpRequest|WebSocket|importScripts/);
  });
});
