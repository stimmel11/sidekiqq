import { withDevice } from "@/lib/auth";
import { config } from "@/lib/env";
import { HttpError, parseJson } from "@/lib/http";
import { SpeakRequestSchema } from "@/lib/models";
import { SpeechError } from "@/lib/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/speak  { text, voice? }  ->  audio/wav (PCM 16-bit LE, mono; 24 kHz with OpenAI).
 * The sample rate is in the WAV header and in `X-Sample-Rate`. `text` is capped at
 * SPEAK_MAX_CHARS (default 1000); longer text gets 413 so the device can split at sentences.
 * Read-only: this never sends anything.
 */
export const POST = withDevice(async (req, { deps }) => {
  const body = await parseJson(req, SpeakRequestSchema);
  const max = config.speakMaxChars();
  if (body.text.length > max) throw new HttpError(413, `text too long (max ${max} characters)`, "text_too_long");
  try {
    const audio = await deps.tts().synthesize(body.text, body.voice);
    return new Response(audio.wav as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(audio.wav.byteLength),
        "X-Sample-Rate": String(audio.sampleRate),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof SpeechError) {
      console.error(err.message);
      throw new HttpError(502, "Speech provider error", "tts_failed");
    }
    throw err;
  }
});
