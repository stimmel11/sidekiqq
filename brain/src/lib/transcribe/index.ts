import { optional, required } from "../env";

export interface Transcriber {
  readonly name: string;
  /** `wav` is a validated 16 kHz mono PCM16 WAV file. */
  transcribe(wav: Uint8Array): Promise<string>;
}

export class TranscriptionError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "TranscriptionError";
  }
}

type FetchLike = typeof fetch;

async function failure(provider: string, res: Response): Promise<TranscriptionError> {
  const detail = (await res.text().catch(() => "")).slice(0, 300);
  return new TranscriptionError(`${provider} transcription failed (${res.status}): ${detail}`, res.status);
}

/** OpenAI Whisper-compatible `/v1/audio/transcriptions` (multipart upload). */
export class OpenAIWhisperTranscriber implements Transcriber {
  readonly name = "openai-whisper";
  constructor(
    private readonly apiKey: string,
    private readonly model = "whisper-1",
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly language: string | undefined = "en",
    private readonly fetchImpl: FetchLike = fetch,
    private readonly prompt?: string,
  ) {}

  async transcribe(wav: Uint8Array): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([wav as BlobPart], { type: "audio/wav" }), "utterance.wav");
    form.append("model", this.model);
    form.append("response_format", "json");
    if (this.language) form.append("language", this.language);
    if (this.prompt) form.append("prompt", this.prompt);
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw await failure("OpenAI", res);
    const json = (await res.json()) as { text?: unknown };
    return typeof json.text === "string" ? json.text.trim() : "";
  }
}

/** Deepgram pre-recorded `/v1/listen` (raw body upload). */
export class DeepgramTranscriber implements Transcriber {
  readonly name = "deepgram";
  constructor(
    private readonly apiKey: string,
    private readonly model = "nova-3",
    private readonly language = "en",
    private readonly fetchImpl: FetchLike = fetch,
    private readonly keyterms: string[] = [],
  ) {}

  async transcribe(wav: Uint8Array): Promise<string> {
    const params = new URLSearchParams({ model: this.model, smart_format: "true", punctuate: "true", language: this.language });
    for (const term of this.keyterms) params.append("keyterm", term);
    const res = await this.fetchImpl(`https://api.deepgram.com/v1/listen?${params}`, {
      method: "POST",
      headers: { Authorization: `Token ${this.apiKey}`, "Content-Type": "audio/wav" },
      body: wav as BodyInit,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw await failure("Deepgram", res);
    const json = (await res.json()) as {
      results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
    };
    return json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
  }
}

/** Vocabulary hint so names like "SideKiqq" and "Outcrop Manor" transcribe correctly. */
function vocabulary(): string[] {
  return (optional("TRANSCRIBE_VOCABULARY") ?? "SideKiqq,Stimmel")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function transcriberFromEnv(): Transcriber {
  const provider = (optional("TRANSCRIBE_PROVIDER") ?? "openai-whisper").toLowerCase();
  switch (provider) {
    case "openai-whisper":
    case "openai":
    case "whisper":
      return new OpenAIWhisperTranscriber(
        required("OPENAI_API_KEY"),
        optional("OPENAI_TRANSCRIBE_MODEL") ?? "whisper-1",
        optional("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
        optional("TRANSCRIBE_LANGUAGE") ?? "en",
        fetch,
        vocabulary().join(", "),
      );
    case "deepgram":
      return new DeepgramTranscriber(
        required("DEEPGRAM_API_KEY"),
        optional("DEEPGRAM_MODEL") ?? "nova-3",
        optional("TRANSCRIBE_LANGUAGE") ?? "en",
        fetch,
        vocabulary(),
      );
    default:
      throw new TranscriptionError(`Unknown TRANSCRIBE_PROVIDER "${provider}" (use "openai-whisper" or "deepgram")`);
  }
}
