/**
 * Browser tap-to-talk audio helpers (docs/WEBAPP.md §6.1). Pure functions, no DOM: the Talk screen
 * (`app/(dashboard)/dashboard/talk/TalkPanel.tsx`) feeds them the mic frames its AudioWorklet
 * collects at the AudioContext's real rate (usually 48 kHz), and uploads the resulting
 * 16 kHz mono PCM16 WAV to /api/transcribe, the only format the brain accepts.
 */

export const TARGET_RATE = 16_000;

/**
 * The browser caps an utterance at 60 s (docs/WEBAPP.md §6.1; /api/transcribe allows 120 s). The
 * page posts the WAV straight to /api/transcribe as the session, so the old 1 MB server-action
 * limit (and its 30 s cap) no longer applies: 60 s of 16 kHz PCM16 is 1 920 044 bytes, well under
 * Vercel's 4.5 MB request body limit.
 */
export const MAX_SECONDS = 60;
export const MAX_WAV_BYTES = 44 + MAX_SECONDS * TARGET_RATE * 2;

function blackman(x: number): number {
  // x in [-1, 1]
  return 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * Band-limited resampling to `outRate` (default 16 kHz): a windowed-sinc interpolator whose
 * cutoff (0.45 × the lower of the two rates, so 7.2 kHz for 16 kHz output) is also the
 * anti-aliasing low-pass. Output length is round(n × outRate / inRate).
 */
export function resample(input: Float32Array, inRate: number, outRate: number = TARGET_RATE): Float32Array {
  if (!Number.isFinite(inRate) || inRate < 8_000 || inRate > 384_000) throw new RangeError(`unsupported input rate ${inRate}`);
  if (!Number.isFinite(outRate) || outRate < 8_000 || outRate > 384_000) throw new RangeError(`unsupported output rate ${outRate}`);
  if (inRate === outRate) return Float32Array.from(input);
  const outLen = Math.round((input.length * outRate) / inRate);
  const out = new Float32Array(outLen);
  if (outLen === 0) return out;

  const fc = (0.45 * Math.min(inRate, outRate)) / inRate; // cutoff, cycles per input sample
  const zeroCrossings = 12;
  const half = Math.ceil(zeroCrossings / (2 * fc)); // kernel half-width in input samples
  const gain = 2 * fc;
  const taps = 2 * half;

  // Polyphase table: output sample n sits at input time n·inRate/outRate, whose fractional part
  // takes only outRate/gcd values (1 for 48 kHz → 16 kHz, 160 for 44.1 kHz). Weights are built
  // once per phase, so a 60 s utterance costs ~taps multiply-adds per output sample.
  const g = gcd(inRate, outRate);
  const phases = outRate / g;
  const exact = Number.isInteger(inRate) && Number.isInteger(outRate) && phases <= 4096;
  const kernelAt = (frac: number): Float64Array => {
    // w[j] multiplies input[center - half + 1 + j]
    const w = new Float64Array(taps);
    let norm = 0;
    for (let j = 0; j < taps; j++) {
      const d = frac + half - 1 - j;
      const h = Math.abs(d) >= half ? 0 : gain * sinc(gain * d) * blackman(d / half);
      w[j] = h;
      norm += h;
    }
    // Normalise by the kernel's DC gain so a constant signal keeps its level.
    if (norm !== 0) for (let j = 0; j < taps; j++) w[j]! /= norm;
    return w;
  };
  const table: (Float64Array | undefined)[] = exact ? new Array(phases) : [];

  for (let n = 0; n < outLen; n++) {
    let center: number;
    let w: Float64Array;
    if (exact) {
      const num = n * inRate; // < 2^53 for any upload we accept
      center = Math.floor(num / outRate);
      const p = (num - center * outRate) / g;
      w = table[p] ??= kernelAt((p * g) / outRate);
    } else {
      const t = (n * inRate) / outRate;
      center = Math.floor(t);
      w = kernelAt(t - center);
    }
    const first = center - half + 1;
    let acc = 0;
    if (first >= 0 && first + taps <= input.length) {
      for (let j = 0; j < taps; j++) acc += input[first + j]! * w[j]!;
    } else {
      for (let j = 0; j < taps; j++) {
        const k = first + j;
        if (k >= 0 && k < input.length) acc += input[k]! * w[j]!;
      }
    }
    out[n] = acc;
  }
  return out;
}

/** Float [-1, 1] → signed 16-bit, clamped. NaN becomes silence. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let v = input[i]!;
    if (Number.isNaN(v)) v = 0;
    v = Math.max(-1, Math.min(1, v));
    out[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
  }
  return out;
}

/** 44-byte RIFF/WAVE header + little-endian PCM16 mono data. */
export function encodeWav(pcm: Int16Array, sampleRate: number = TARGET_RATE): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buf = new Uint8Array(44 + dataBytes);
  const view = new DataView(buf.buffer);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i]!, true);
  return buf;
}

/** Joins captured frames, resamples to 16 kHz, trims to MAX_SECONDS and encodes the upload. */
export function framesToWav(frames: readonly Float32Array[], inRate: number): Uint8Array {
  let total = 0;
  for (const f of frames) total += f.length;
  const joined = new Float32Array(total);
  let off = 0;
  for (const f of frames) {
    joined.set(f, off);
    off += f.length;
  }
  const at16k = resample(joined, inRate, TARGET_RATE);
  const capped = at16k.length > MAX_SECONDS * TARGET_RATE ? at16k.subarray(0, MAX_SECONDS * TARGET_RATE) : at16k;
  return encodeWav(floatToPcm16(capped), TARGET_RATE);
}

export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return Math.sqrt(sum / frame.length);
}

export type EndpointDecision = "continue" | "silence" | "no_speech" | "max";

export interface EndpointerOptions {
  /** RMS above this counts as speech. About -36 dBFS; the browser's AGC is on. */
  threshold?: number;
  /** Speech this long (ms, cumulative) before silence can end the turn, so a click doesn't count. */
  minSpeechMs?: number;
  /** Silence after speech that ends the turn. */
  silenceMs?: number;
  /** Stop if nothing was said this long after the tap. */
  noSpeechMs?: number;
  maxMs?: number;
}

/**
 * The simple energy gate from §6.1: after some speech, 2 s of quiet stops the recording; nothing
 * said for 8 s or MAX_SECONDS (60 s) in total also stops. A second tap always stops (handled by the page).
 */
export class Endpointer {
  private readonly threshold: number;
  private readonly minSpeechMs: number;
  private readonly silenceMs: number;
  private readonly noSpeechMs: number;
  private readonly maxMs: number;
  private elapsedMs = 0;
  private speechMs = 0;
  private quietMs = 0;

  constructor(opts: EndpointerOptions = {}) {
    this.threshold = opts.threshold ?? 0.016;
    this.minSpeechMs = opts.minSpeechMs ?? 150;
    this.silenceMs = opts.silenceMs ?? 2_000;
    this.noSpeechMs = opts.noSpeechMs ?? 8_000;
    this.maxMs = Math.min(opts.maxMs ?? MAX_SECONDS * 1000, MAX_SECONDS * 1000);
  }

  get heardSpeech(): boolean {
    return this.speechMs >= this.minSpeechMs;
  }

  feed(frame: Float32Array, sampleRate: number): EndpointDecision {
    const ms = (frame.length / sampleRate) * 1000;
    this.elapsedMs += ms;
    if (rms(frame) >= this.threshold) {
      this.speechMs += ms;
      this.quietMs = 0;
    } else {
      this.quietMs += ms;
    }
    if (this.elapsedMs >= this.maxMs) return "max";
    if (this.heardSpeech && this.quietMs >= this.silenceMs) return "silence";
    if (!this.heardSpeech && this.elapsedMs >= this.noSpeechMs) return "no_speech";
    return "continue";
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
