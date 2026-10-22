import { optional, required } from "../env";
import { encodeWav } from "../transcribe/wav";

/**
 * Text-to-speech, abstracted like transcription (lib/transcribe). Used by POST /api/speak so a
 * device with a speaker but no good on-device TTS (Reachy Mini) can play the brain's reply.
 *
 * Output contract: a complete RIFF/WAVE file, PCM 16-bit little-endian, mono. The sample rate is
 * whatever the provider produces (OpenAI: 24 kHz) and is stated in the WAV header and the
 * `X-Sample-Rate` response header.
 */
export interface SpeechAudio {
  wav: Uint8Array;
  sampleRate: number;
}

export interface SpeechSynthesizer {
  readonly name: string;
  synthesize(text: string, voice?: string): Promise<SpeechAudio>;
}

export class SpeechError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "SpeechError";
  }
}

type FetchLike = typeof fetch;

/** Wrap raw PCM16 LE mono bytes in a WAV header. An odd trailing byte is dropped. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const even = pcm.byteLength - (pcm.byteLength % 2);
  const samples = new Int16Array(even / 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, even);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return encodeWav(samples, sampleRate);
}

/**
 * OpenAI-compatible `/v1/audio/speech`. We ask for `pcm` (raw 24 kHz 16-bit mono LE) and add the
 * WAV header ourselves: OpenAI's own `wav` output is streamed with placeholder chunk sizes, which
 * some players reject.
 */
export class OpenAISpeechSynthesizer implements SpeechSynthesizer {
  readonly name = "openai";
  static readonly SAMPLE_RATE = 24_000;
  constructor(
    private readonly apiKey: string,
    private readonly model = "gpt-4o-mini-tts",
    private readonly defaultVoice = "alloy",
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly fetchImpl: FetchLike = fetch,
    private readonly instructions?: string,
  ) {}

  async synthesize(text: string, voice?: string): Promise<SpeechAudio> {
    const body: Record<string, string> = {
      model: this.model,
      input: text,
      voice: voice ?? this.defaultVoice,
      response_format: "pcm",
    };
    // `instructions` is only understood by the gpt-4o-*-tts models.
    if (this.instructions && this.model.includes("gpt-4o")) body.instructions = this.instructions;
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new SpeechError(`OpenAI speech failed (${res.status}): ${detail}`, res.status);
    }
    const pcm = new Uint8Array(await res.arrayBuffer());
    if (pcm.byteLength < 2) throw new SpeechError("OpenAI speech returned no audio");
    return { wav: pcm16ToWav(pcm, OpenAISpeechSynthesizer.SAMPLE_RATE), sampleRate: OpenAISpeechSynthesizer.SAMPLE_RATE };
  }
}

export function speechSynthesizerFromEnv(): SpeechSynthesizer {
  const provider = (optional("TTS_PROVIDER") ?? "openai").toLowerCase();
  switch (provider) {
    case "openai":
      return new OpenAISpeechSynthesizer(
        required("OPENAI_API_KEY"),
        optional("OPENAI_TTS_MODEL") ?? "gpt-4o-mini-tts",
        optional("OPENAI_TTS_VOICE") ?? "alloy",
        optional("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
        fetch,
        optional("OPENAI_TTS_INSTRUCTIONS") ?? "Speak like a calm, concise executive assistant.",
      );
    default:
      throw new SpeechError(`Unknown TTS_PROVIDER "${provider}" (use "openai")`);
  }
}
