"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDeps } from "@/lib/deps";
import { config } from "@/lib/env";
import { approveDraftFromDashboard, completeCommitmentFromDashboard, discardDraftFromDashboard } from "@/lib/dashboard/approval";
import { logout, requireOwnerSession } from "@/lib/dashboard/owner";
import type { ConfirmState } from "@/components/ui/ConfirmDialog";

/**
 * Dashboard server actions. Each one re-checks the owner session (middleware already did) and
 * delegates to the existing route handlers through lib/dashboard/approval.ts.
 */

function idFrom(form: FormData): string {
  const id = form.get("id");
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : "";
}

function str(form: FormData, name: string): string | null {
  const v = form.get(name);
  return typeof v === "string" ? v : null;
}

export async function approveDraftAction(_prev: ConfirmState, form: FormData): Promise<ConfirmState> {
  await requireOwnerSession();
  const id = idFrom(form);
  if (!id) return { error: "Missing draft id." };
  const result = await approveDraftFromDashboard(getDeps(), id, { confirm: str(form, "confirm"), confirmation: str(form, "confirmation") });
  if (!result.ok) return { error: result.error };
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/drafts?done=sent");
}

export async function discardDraftAction(_prev: ConfirmState, form: FormData): Promise<ConfirmState> {
  await requireOwnerSession();
  const id = idFrom(form);
  if (!id) return { error: "Missing draft id." };
  const result = await discardDraftFromDashboard(getDeps(), id);
  if (!result.ok) return { error: result.error };
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/drafts?done=discarded");
}

export async function completeCommitmentAction(form: FormData): Promise<void> {
  await requireOwnerSession();
  const id = idFrom(form);
  if (!id) return;
  const result = await completeCommitmentFromDashboard(getDeps(), id);
  const back = str(form, "back");
  const status = back === "overdue" || back === "all" ? back : "open";
  revalidatePath("/dashboard", "layout");
  redirect(`/dashboard/commitments?status=${status}&done=${result.ok ? "completed" : "error"}`);
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

export async function logoutAction(): Promise<void> {
  await logout();
  redirect("/login");
}
