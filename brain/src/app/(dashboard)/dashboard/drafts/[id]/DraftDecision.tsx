"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { ConfirmDialog, type ConfirmState } from "@/components/ui/ConfirmDialog";
import { approveDraft, discardDraft } from "@/lib/dashboard/browser-api";

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

  async function finish(done: "sent" | "discarded"): Promise<ConfirmState> {
    router.replace(`/dashboard/drafts?done=${done}`);
    router.refresh();
    return undefined;
  }

  async function onApprove(): Promise<ConfirmState> {
    const r = await approveDraft(id, confirmation);
    return r.ok ? finish("sent") : { error: r.error };
  }

  async function onDiscard(): Promise<ConfirmState> {
    const r = await discardDraft(id);
    return r.ok ? finish("discarded") : { error: r.error };
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
