import { withDevice } from "@/lib/auth";
import { HttpError, json } from "@/lib/http";
import { TranscriptionError } from "@/lib/transcribe";
import { assertContractWav, parseWav, WavError } from "@/lib/transcribe/wav";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 16 kHz * 2 bytes * 120 s + header: generous cap for a single utterance. */
const MAX_BYTES = 16_000 * 2 * 120 + 1024;

export const POST = withDevice(async (req, { deps }) => {
  const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type && !["audio/wav", "audio/x-wav", "audio/wave", "application/octet-stream"].includes(type)) {
    throw new HttpError(415, "Content-Type must be audio/wav");
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) throw new HttpError(413, "Audio too long (max 120 s)");

  const audio = new Uint8Array(await req.arrayBuffer());
  if (audio.byteLength > MAX_BYTES) throw new HttpError(413, "Audio too long (max 120 s)");
  try {
    assertContractWav(parseWav(audio));
  } catch (err) {
    if (err instanceof WavError) throw new HttpError(422, err.message, "bad_audio");
    throw err;
  }

  try {
    const text = await deps.transcriber().transcribe(audio);
    return json({ text });
  } catch (err) {
    if (err instanceof TranscriptionError) {
      console.error(err.message);
      throw new HttpError(502, "Transcription provider error", "stt_failed");
    }
    throw err;
  }
});
