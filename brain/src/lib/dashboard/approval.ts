import { POST as approveRoute } from "@/app/api/drafts/[id]/approve/route";
import { POST as discardRoute } from "@/app/api/drafts/[id]/discard/route";
import { POST as completeRoute } from "@/app/api/commitments/[id]/complete/route";
import { sha256 } from "../crypto";
import type { Deps } from "../deps";
import type { Draft } from "../models";
import { callAsDashboardDevice, type RouteResult } from "./device-bridge";

/**
 * Dashboard draft approval. The owner must open the confirmation dialog, which shows the
 * recipients, subject and body, and press its send button. The dialog posts:
 *   - confirm = "send"            (only the dialog's button carries this value)
 *   - confirmation = fingerprint  (hash of exactly what the dialog displayed)
 * The server recomputes the fingerprint from the stored draft and refuses on any mismatch, so a
 * stale page or a draft that changed after the dialog opened can never be sent. Only then is the
 * existing POST /api/drafts/:id/approve handler invoked: the one and only send path.
 */

export const CONFIRM_VALUE = "send";

export function draftFingerprint(d: Pick<Draft, "id" | "to" | "cc" | "subject" | "body">): string {
  return sha256(JSON.stringify(["v1", d.id, d.to, d.cc ?? [], d.subject, d.body]));
}

export type ApprovalCheck = { ok: true } | { ok: false; status: number; error: string };

export function checkApprovalConfirmation(
  draft: Draft | null,
  form: { confirm?: string | null; confirmation?: string | null },
): ApprovalCheck {
  if (!draft) return { ok: false, status: 404, error: "This draft no longer exists." };
  if (draft.status !== "pending") return { ok: false, status: 409, error: `This draft was already ${draft.status}.` };
  if (form.confirm !== CONFIRM_VALUE) return { ok: false, status: 400, error: "Confirm the recipient, subject and body before sending." };
  if (!form.confirmation || form.confirmation !== draftFingerprint(draft)) {
    return { ok: false, status: 409, error: "The draft changed after you opened it. Review it again before sending." };
  }
  return { ok: true };
}

export type ActionOutcome = { ok: true } | { ok: false; error: string };

/** Route error codes whose own message is the one to show (more specific than the status). */
const CODE_MESSAGES: Record<string, string> = {
  changed_in_provider: "The draft was changed in Gmail after it was drafted, so nothing was sent. It has been marked discarded; review it in Gmail.",
  no_provider_draft: "This draft has no Gmail draft attached, so it can't be sent from here.",
  unsupported_kind: "This kind of draft can't be approved yet. Nothing was sent.",
};

function outcome(r: RouteResult, messages: Record<number, string> = {}): ActionOutcome {
  if (r.status >= 200 && r.status < 300) return { ok: true };
  const byCode = r.body.code ? CODE_MESSAGES[r.body.code] : undefined;
  return { ok: false, error: byCode ?? messages[r.status] ?? r.body.error ?? `Request failed (${r.status}).` };
}

export async function approveDraftFromDashboard(
  deps: Deps,
  id: string,
  form: { confirm?: string | null; confirmation?: string | null },
  key?: Buffer,
): Promise<ActionOutcome> {
  const check = checkApprovalConfirmation(await deps.repos.drafts.get(id), form);
  if (!check.ok) return { ok: false, error: check.error };
  const r = await callAsDashboardDevice(deps, approveRoute, `/api/drafts/${encodeURIComponent(id)}/approve`, { id }, key);
  return outcome(r, {
    409: "This draft is already being sent or is no longer pending.",
    410: "The Gmail draft was deleted, so nothing was sent. It has been marked discarded.",
    500: "The server reported an error. Check Drafts and Gmail before trying again.",
    503: "Gmail isn't connected or the server isn't configured, so nothing was sent.",
  });
}

export async function discardDraftFromDashboard(deps: Deps, id: string, key?: Buffer): Promise<ActionOutcome> {
  return outcome(await callAsDashboardDevice(deps, discardRoute, `/api/drafts/${encodeURIComponent(id)}/discard`, { id }, key));
}

export async function completeCommitmentFromDashboard(deps: Deps, id: string, key?: Buffer): Promise<ActionOutcome> {
  return outcome(await callAsDashboardDevice(deps, completeRoute, `/api/commitments/${encodeURIComponent(id)}/complete`, { id }, key));
}
