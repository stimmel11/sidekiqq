/**
 * Talk screen → brain calls made FROM THE BROWSER as the signed-in session (web app slice
 * 2c-ii-b-ii, docs/WEBAPP.md §6). Client-safe: no server imports.
 *
 * The page posts straight to the same three device routes every other device uses, which accept
 * the session through `withPrincipal` (session cookie + fail-closed same-origin check; a session
 * asks only as `web`): `/api/transcribe` (16 kHz WAV) → `/api/ask` (`device: "web"`) →
 * `/api/speak` (24 kHz WAV, played by the page).
 *
 * Nothing here can send. These helpers only ever post to those three paths; a `draft_created`
 * action only links to the Drafts screen, whose confirm dialog is the dashboard's one path to
 * `POST /api/drafts/:id/approve` (lib/dashboard/browser-api.ts).
 */

import type { Action } from "../models";
import { MAX_SECONDS, MAX_WAV_BYTES } from "./audio";

export interface TalkReply {
  text: string;
  reply: string;
  spoken: string;
  conversationId: string;
  actions: Action[];
}

/** `signIn` is set when the session has expired, so the page can send the owner to /login. */
export type TalkOutcome = ({ ok: true } & TalkReply) | { ok: false; error: string; text?: string; signIn?: true };
export type SpeakOutcome = { ok: true; wav: ArrayBuffer } | { ok: false; error: string; signIn?: true };

/** The subset of `fetch` used here (injectable for tests). */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_TYPED_CHARS = 8000;
/** The brain's SPEAK_MAX_CHARS default; the Talk page passes the configured value. */
export const DEFAULT_SPEAK_MAX_CHARS = 1000;

export const TALK_SESSION_EXPIRED = "Your session has expired. Sign in again.";
const OFFLINE = "Couldn't reach SideKiqq. Check the connection and try again.";
const TOO_LONG = `That was too long. Keep it under ${MAX_SECONDS} seconds.`;

export const ACTION_TYPES = new Set<Action["type"]>(["draft_created", "commitment_added", "event_proposed"]);
export const DRAFT_KINDS = new Set<NonNullable<Action["draftKind"]>>(["email", "calendar_invite", "calendar_hold"]);

/** Keeps only well-formed actions (the `ActionSchema` shape); an unexpected one is dropped rather than shown. */
export function cleanActions(raw: unknown): Action[] {
  if (!Array.isArray(raw)) return [];
  const out: Action[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    if (typeof r.type !== "string" || !ACTION_TYPES.has(r.type as Action["type"])) continue;
    if (typeof r.id !== "string" || typeof r.summary !== "string") continue;
    if (r.draftKind !== undefined && (typeof r.draftKind !== "string" || !DRAFT_KINDS.has(r.draftKind as NonNullable<Action["draftKind"]>))) continue;
    out.push({
      type: r.type as Action["type"],
      id: r.id,
      summary: r.summary,
      ...(r.draftKind !== undefined ? { draftKind: r.draftKind as Action["draftKind"] } : {}),
    });
  }
  return out;
}

function routeError(status: number, body: Record<string, unknown>, what: string): { error: string; signIn?: true } {
  if (status === 401) return { error: TALK_SESSION_EXPIRED, signIn: true };
  if (status === 403) return { error: "The request was refused by the browser check. Reload the page and try again." };
  if (status === 413) return { error: what === "Voice reply" ? "The voice reply was too long to play." : TOO_LONG };
  if (status === 429) return { error: "Too many requests right now. Wait a moment and try again." };
  if (body.code === "bad_audio") return { error: "The recording couldn't be read. Try again." };
  if (body.code === "stt_failed") return { error: "Transcription isn't working right now. Try again, or type instead." };
  if (body.code === "tts_failed") return { error: "The voice reply isn't available right now." };
  if (status === 503) return { error: `${what} isn't configured on the server.` };
  return { error: `${what} failed (${status}). Try again.` };
}

function request(fetchFn: FetchLike, path: "/api/transcribe" | "/api/ask" | "/api/speak", body: BodyInit, contentType: string): Promise<Response> {
  return fetchFn(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "content-type": contentType },
    body,
  });
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function defaultFetch(): FetchLike {
  return (input, init) => globalThis.fetch(input, init);
}

/** One typed (or transcribed) turn: `POST /api/ask` as `web`. */
export async function askText(text: string, conversationId: string | null | undefined, fetchFn: FetchLike = defaultFetch()): Promise<TalkOutcome> {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return { ok: false, error: "Say or type something first." };
  if (trimmed.length > MAX_TYPED_CHARS) return { ok: false, error: `That's too long (max ${MAX_TYPED_CHARS} characters).`, text: trimmed };
  const conv = conversationId && CONVERSATION_ID.test(conversationId) ? conversationId : undefined;
  let res: Response;
  try {
    res = await request(fetchFn, "/api/ask", JSON.stringify({ text: trimmed, device: "web", ...(conv ? { conversationId: conv } : {}) }), "application/json");
  } catch {
    return { ok: false, error: OFFLINE, text: trimmed };
  }
  const b = await jsonBody(res);
  if (res.status < 200 || res.status >= 300) return { ok: false, ...routeError(res.status, b, "SideKiqq"), text: trimmed };
  return {
    ok: true,
    text: trimmed,
    reply: typeof b.reply === "string" ? b.reply : "",
    spoken: typeof b.spoken === "string" ? b.spoken : "",
    conversationId: typeof b.conversationId === "string" && CONVERSATION_ID.test(b.conversationId) ? b.conversationId : (conv ?? ""),
    actions: cleanActions(b.actions),
  };
}

/** One recorded turn: the 16 kHz WAV to `/api/transcribe`, then the transcript to `/api/ask`. */
export async function talk(wav: Uint8Array, conversationId: string | null | undefined, fetchFn: FetchLike = defaultFetch()): Promise<TalkOutcome> {
  if (wav.byteLength <= 44) return { ok: false, error: "Nothing was recorded. Check the microphone and try again." };
  if (wav.byteLength > MAX_WAV_BYTES) return { ok: false, error: TOO_LONG };
  let res: Response;
  try {
    res = await request(fetchFn, "/api/transcribe", new Blob([wav as BlobPart], { type: "audio/wav" }), "audio/wav");
  } catch {
    return { ok: false, error: OFFLINE };
  }
  const b = await jsonBody(res);
  if (res.status < 200 || res.status >= 300) return { ok: false, ...routeError(res.status, b, "Transcription") };
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (!text) return { ok: false, error: "I didn't catch anything. Try again a little closer to the mic." };
  return askText(text, conversationId, fetchFn);
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

/** The reply's `spoken` text as a WAV from `/api/speak` (24 kHz). Read-only. */
export async function speak(text: string, maxChars: number = DEFAULT_SPEAK_MAX_CHARS, fetchFn: FetchLike = defaultFetch()): Promise<SpeakOutcome> {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return { ok: false, error: "Nothing to say." };
  const max = Number.isFinite(maxChars) && maxChars >= 1 ? Math.floor(maxChars) : DEFAULT_SPEAK_MAX_CHARS;
  let res: Response;
  try {
    res = await request(fetchFn, "/api/speak", JSON.stringify({ text: fitForSpeech(trimmed, max) }), "application/json");
  } catch {
    return { ok: false, error: "The voice reply isn't available right now." };
  }
  if (res.status !== 200 || !(res.headers.get("content-type") ?? "").startsWith("audio/wav")) {
    return { ok: false, ...routeError(res.status, await jsonBody(res), "Voice reply") };
  }
  return { ok: true, wav: await res.arrayBuffer() };
}
