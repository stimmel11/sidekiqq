"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDeps } from "@/lib/deps";
import { config } from "@/lib/env";
import { logout, requireOwnerSession } from "@/lib/dashboard/owner";
import { disconnect, setCapability, startConnect } from "@/lib/connectors/manage";
import { HttpError } from "@/lib/http";
import type { ConfirmState } from "@/components/ui/ConfirmDialog";
import { askFromDashboard, speakFromDashboard, talkFromDashboard, type SpeakOutcome, type TalkOutcome } from "@/lib/dashboard/talk";
import { MAX_WAV_BYTES } from "@/lib/talk/audio";

/**
 * Dashboard server actions. Each one re-checks the owner session (middleware already did).
 * Drafts (approve / discard) and commitments (complete) are not here: the browser posts those to
 * the API routes as the session (lib/dashboard/browser-api.ts, docs/WEBAPP.md §4.2).
 */

function str(form: FormData, name: string): string | null {
  const v = form.get(name);
  return typeof v === "string" ? v : null;
}

export type PairCodeState = { code?: string; expiresAt?: string; ttlSeconds?: number; label?: string; error?: string } | undefined;

/** Same repo call as POST /api/devices/pair-code; the session replaces the owner-secret header. */
export async function createPairCodeAction(_prev: PairCodeState, form: FormData): Promise<PairCodeState> {
  await requireOwnerSession();
  const raw = str(form, "label")?.trim() ?? "";
  const label = raw.slice(0, 64) || undefined;
  try {
    const ttl = config.pairCodeTtlSeconds();
    const { code, expiresAt } = await getDeps().repos.pairing.issue(ttl, label);
    return { code, expiresAt, ttlSeconds: ttl, ...(label ? { label } : {}) };
  } catch (err) {
    console.error("[dashboard] pair code failed", err);
    return { error: "Couldn't create a pairing code. Check the Redis connection and try again." };
  }
}

// ------------------------------------------------------------------------- connections

const CONNECTIONS = "/dashboard/connections";

function connectorIdFrom(form: FormData): string {
  const id = form.get("connectorId");
  return typeof id === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(id) ? id : "";
}

function errorCode(err: unknown): string {
  if (err instanceof HttpError) return err.code === "not_connected" ? "not_connected" : err.status === 404 || err.status === 400 ? "unknown" : "save";
  return "save";
}

/** Starts the provider sign-in (same flow as POST /api/connections/:id/connect, the session replaces the ticket). */
export async function connectConnectorAction(form: FormData): Promise<void> {
  await requireOwnerSession();
  const id = connectorIdFrom(form);
  let url: string | null = null;
  try {
    if (id) url = await startConnect(getDeps(), id);
  } catch (err) {
    console.error("[dashboard] connect failed", err);
  }
  redirect(url ?? `${CONNECTIONS}?error=connect`);
}

/** Turns one capability on or off. Only the connector's own capabilities are accepted; tiers never change. */
export async function setCapabilityAction(form: FormData): Promise<void> {
  await requireOwnerSession();
  const id = connectorIdFrom(form);
  const cap = str(form, "capability") ?? "";
  const on = str(form, "on") === "1";
  let to = `${CONNECTIONS}?done=saved`;
  try {
    if (!id) throw new HttpError(404, "unknown connector", "unknown_connector");
    await setCapability(getDeps(), id, cap, on);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error("[dashboard] capability change failed", err);
    to = `${CONNECTIONS}?error=${errorCode(err)}`;
  }
  revalidatePath(CONNECTIONS);
  redirect(to);
}

/** Disconnect, from the confirmation dialog only (`confirm=disconnect`). */
export async function disconnectConnectorAction(_prev: ConfirmState, form: FormData): Promise<ConfirmState> {
  await requireOwnerSession();
  const id = connectorIdFrom(form);
  if (!id) return { error: "Missing connector." };
  if (str(form, "confirm") !== "disconnect") return { error: "Confirm the disconnect in the dialog." };
  let revoked = false;
  try {
    revoked = (await disconnect(getDeps(), id)).revoked;
  } catch (err) {
    console.error("[dashboard] disconnect failed", err);
    return { error: "Couldn't disconnect. Reload and try again." };
  }
  revalidatePath("/dashboard", "layout");
  redirect(`${CONNECTIONS}?done=${revoked ? "disconnected" : "disconnected_local"}`);
}

// ------------------------------------------------------------------------- talk (web app slice 2b)

/** One recorded turn: `audio` is the 16 kHz WAV the Talk screen encoded. Transcribe, then ask as the `web` device. */
export async function talkAction(form: FormData): Promise<TalkOutcome> {
  await requireOwnerSession();
  const audio = form.get("audio");
  if (!(audio instanceof Blob)) return { ok: false, error: "Nothing was recorded." };
  if (audio.size > MAX_WAV_BYTES) return { ok: false, error: "That was too long. Keep it under 30 seconds." };
  try {
    return await talkFromDashboard(getDeps(), new Uint8Array(await audio.arrayBuffer()), str(form, "conversationId"));
  } catch (err) {
    console.error("[dashboard] talk failed", err);
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

/** The same turn, typed instead of spoken. */
export async function askTextAction(text: string, conversationId: string | null): Promise<TalkOutcome> {
  await requireOwnerSession();
  if (typeof text !== "string") return { ok: false, error: "Type something first." };
  try {
    return await askFromDashboard(getDeps(), text, typeof conversationId === "string" ? conversationId : null);
  } catch (err) {
    console.error("[dashboard] ask failed", err);
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

/** The reply's `spoken` text as audio. Read-only. */
export async function speakAction(text: string): Promise<SpeakOutcome> {
  await requireOwnerSession();
  if (typeof text !== "string") return { ok: false, error: "Nothing to say." };
  try {
    return await speakFromDashboard(getDeps(), text);
  } catch (err) {
    console.error("[dashboard] speak failed", err);
    return { ok: false, error: "The voice reply isn't available right now." };
  }
}

export async function logoutAction(): Promise<void> {
  await logout();
  redirect("/login");
}
