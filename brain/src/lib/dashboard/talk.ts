import { POST as askRoute } from "@/app/api/ask/route";
import { POST as speakRoute } from "@/app/api/speak/route";
import { POST as transcribeRoute } from "@/app/api/transcribe/route";
import type { Deps } from "../deps";
import { config } from "../env";
import { ActionSchema, type Action } from "../models";
import { MAX_WAV_BYTES, bytesToBase64 } from "../talk/audio";
import { callAsDashboardDevice, requestAsDashboardDevice } from "./device-bridge";

/**
 * Tap-to-talk on the dashboard (web app slice 2b, docs/WEBAPP.md §6). The browser records and
 * encodes a 16 kHz WAV; these helpers run the same three device routes every other device uses,
 * in-process as the dashboard's `web` device: /api/transcribe → /api/ask (device "web") →
 * /api/speak. Nothing here can send: a `draft_created` action only links to the Drafts screen,
 * whose confirm dialog is the dashboard's one path to POST /api/drafts/:id/approve.
 *
 * Once `withPrincipal` lands (slice 2c) the browser calls these routes directly and this bridge
 * goes away with the rest of `device-bridge.ts`.
 */

export interface TalkReply {
  text: string;
  reply: string;
  spoken: string;
  conversationId: string;
  actions: Action[];
}

export type TalkOutcome = ({ ok: true } & TalkReply) | { ok: false; error: string; text?: string };
export type SpeakOutcome = { ok: true; wavBase64: string } | { ok: false; error: string };

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_TYPED_CHARS = 8000;

function routeError(status: number, body: { error?: string; code?: string }, what: string): string {
  if (status === 401 || status === 403) return "The dashboard's device session failed. Reload the page and try again.";
  if (status === 413) return "That was too long. Keep it under 30 seconds.";
  if (status === 429) return "Too many requests right now. Wait a moment and try again.";
  if (body.code === "bad_audio") return "The recording couldn't be read. Try again.";
  if (body.code === "stt_failed") return "Transcription isn't working right now. Try again, or type instead.";
  if (body.code === "tts_failed") return "The voice reply isn't available right now.";
  if (status === 503) return `${what} isn't configured on the server.`;
  return `${what} failed (${status}). Try again.`;
}

/** Keeps only well-formed actions; an unexpected shape is dropped rather than shown. */
function cleanActions(raw: unknown): Action[] {
  if (!Array.isArray(raw)) return [];
  const out: Action[] = [];
  for (const a of raw) {
    const parsed = ActionSchema.safeParse(a);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export async function askFromDashboard(deps: Deps, text: string, conversationId?: string | null, key?: Buffer): Promise<TalkOutcome> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Say or type something first." };
  if (trimmed.length > MAX_TYPED_CHARS) return { ok: false, error: `That's too long (max ${MAX_TYPED_CHARS} characters).`, text: trimmed };
  const conv = conversationId && CONVERSATION_ID.test(conversationId) ? conversationId : undefined;
  const r = await callAsDashboardDevice(deps, askRoute, "/api/ask", {}, key, {
    json: { text: trimmed, device: "web", ...(conv ? { conversationId: conv } : {}) },
  });
  if (r.status < 200 || r.status >= 300) return { ok: false, error: routeError(r.status, r.body, "SideKiqq"), text: trimmed };
  const b = r.body as Record<string, unknown>;
  return {
    ok: true,
    text: trimmed,
    reply: typeof b.reply === "string" ? b.reply : "",
    spoken: typeof b.spoken === "string" ? b.spoken : "",
    conversationId: typeof b.conversationId === "string" ? b.conversationId : (conv ?? ""),
    actions: cleanActions(b.actions),
  };
}

export async function talkFromDashboard(deps: Deps, wav: Uint8Array, conversationId?: string | null, key?: Buffer): Promise<TalkOutcome> {
  if (wav.byteLength <= 44) return { ok: false, error: "Nothing was recorded. Check the microphone and try again." };
  if (wav.byteLength > MAX_WAV_BYTES) return { ok: false, error: "That was too long. Keep it under 30 seconds." };
  const t = await callAsDashboardDevice(deps, transcribeRoute, "/api/transcribe", {}, key, { bytes: wav, contentType: "audio/wav" });
  if (t.status < 200 || t.status >= 300) return { ok: false, error: routeError(t.status, t.body, "Transcription") };
  const text = typeof t.body.text === "string" ? t.body.text.trim() : "";
  if (!text) return { ok: false, error: "I didn't catch anything. Try again a little closer to the mic." };
  return askFromDashboard(deps, text, conversationId, key);
}

/**
 * `spoken` is meant to be two sentences, but /api/speak refuses text over SPEAK_MAX_CHARS. Keep the
 * whole sentences that fit (the full reply is on screen), else cut at a word boundary.
 */
export function fitForSpeech(text: string, max: number): string {
  if (text.length <= max) return text;
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  let out = "";
  for (const s of sentences) {
    if ((out + s).trimEnd().length > max) break;
    out += s;
  }
  out = out.trim();
  if (out) return out;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).trim();
}

/** The spoken reply as a base64 WAV (24 kHz from OpenAI). Read-only. */
export async function speakFromDashboard(deps: Deps, text: string, key?: Buffer): Promise<SpeakOutcome> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Nothing to say." };
  const res = await requestAsDashboardDevice(deps, speakRoute, "/api/speak", {}, key, { json: { text: fitForSpeech(trimmed, config.speakMaxChars()) } });
  if (res.status !== 200 || !(res.headers.get("content-type") ?? "").startsWith("audio/wav")) {
    let body: { error?: string; code?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // not JSON
    }
    return { ok: false, error: routeError(res.status, body, "Voice reply") };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { ok: true, wavBase64: bytesToBase64(bytes) };
}
