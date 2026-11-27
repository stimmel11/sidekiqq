"use client";

import { useRouter } from "next/navigation";
import { useRef, type ReactNode } from "react";
import { ConfirmDialog, type ConfirmState } from "@/components/ui/ConfirmDialog";
import { SESSION_EXPIRED, approveDraft, discardDraft } from "@/lib/dashboard/browser-api";

type Props = {
  id: string;
  /** `draftFingerprint` of exactly what `approveBody` shows, computed on the server. */
  confirmation: string;
  invite: boolean;
  approvable: boolean;
  /** What the send dialog shows: recipients, subject (or time and place) and the full body. */
  approveBody: ReactNode;
  discardBody: ReactNode;
};

/**
 * Discard / Approve-and-send for one pending draft. Both post from the browser as the signed-in
 * session (lib/dashboard/browser-api.ts). Sending happens only from the send dialog's own button,
 * and the approve route refuses unless the fingerprint matches the draft as it is now.
 */
export function DraftDecision({ id, confirmation, invite, approvable, approveBody, discardBody }: Props) {
  const router = useRouter();
  // Once a decision succeeded, further clicks (before navigation commits) do nothing.
  const settled = useRef(false);

  async function finish(done: "sent" | "sent_warning" | "discarded"): Promise<ConfirmState> {
    settled.current = true;
    router.replace(`/dashboard/drafts?done=${done}`);
    router.refresh();
    return undefined;
  }

  async function onApprove(): Promise<ConfirmState> {
    if (settled.current) return undefined;
    const r = await approveDraft(id, confirmation);
    if (!r.ok) return unauthorized(r.error) ?? { error: r.error };
    // The route's warning (ARCHITECTURE.md: show or speak it) becomes a fixed notice on Drafts.
    return finish(r.warning ? "sent_warning" : "sent");
  }

  async function onDiscard(): Promise<ConfirmState> {
    if (settled.current) return undefined;
    const r = await discardDraft(id);
    return r.ok ? finish("discarded") : (unauthorized(r.error) ?? { error: r.error });
  }

  /** An expired session goes to sign-in (and back to this draft); nothing was changed. */
  function unauthorized(error: string): ConfirmState | null {
    if (error !== SESSION_EXPIRED) return null;
    router.replace(`/login?next=${encodeURIComponent(`/dashboard/drafts/${id}`)}`);
    return { error };
  }

  return (
    <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
      <ConfirmDialog
        triggerLabel="Discard"
        triggerVariant="secondary"
        title="Discard this draft?"
        action={onDiscard}
        fields={{}}
        confirmLabel="Discard draft"
        confirmVariant="danger"
        pendingLabel="Discarding…"
      >
        {discardBody}
      </ConfirmDialog>
      {approvable && (
        <ConfirmDialog
          triggerLabel={invite ? "Approve and send invite" : "Approve and send"}
          title={invite ? "Send this invite?" : "Send this email?"}
          action={onApprove}
          fields={{}}
          confirmLabel={invite ? "Send invite" : "Send email"}
          pendingLabel="Sending…"
        >
          {approveBody}
        </ConfirmDialog>
      )}
    </div>
  );
}
