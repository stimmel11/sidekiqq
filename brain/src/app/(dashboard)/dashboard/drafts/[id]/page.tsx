import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Tag } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { getDeps } from "@/lib/deps";
import { CONFIRM_VALUE, draftFingerprint } from "@/lib/dashboard/approval";
import { formatDateTime } from "@/lib/dashboard/format";
import { requireOwnerSession } from "@/lib/dashboard/owner";
import type { Draft } from "@/lib/models";
import { approveDraftAction, discardDraftAction } from "../../actions";

export const metadata: Metadata = { title: "Draft" };
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function Envelope({ draft }: { draft: Draft }) {
  const rows: [string, string][] = [
    ["To", draft.to.join(", ")],
    ...(draft.cc.length ? ([["Cc", draft.cc.join(", ")]] as [string, string][]) : []),
    ["Subject", draft.subject || "(no subject)"],
  ];
  return (
    <dl className="grid grid-cols-[3.75rem_minmax(0,1fr)] sm:grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-body">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-text-muted">{k}</dt>
          <dd className="break-words font-medium text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Body({ text }: { text: string }) {
  return <div className="whitespace-pre-wrap break-words text-body text-text">{text}</div>;
}

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwnerSession();
  const { id } = await params;
  const draft = await getDeps().repos.drafts.get(id);
  if (!draft) notFound();
  const pending = draft.status === "pending";

  return (
    <article>
      <div className="mb-4">
        <ButtonLink href="/dashboard/drafts" variant="ghost" size="sm" className="-ml-3">
          Back to drafts
        </ButtonLink>
      </div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words font-heading text-h1 text-text">{draft.subject || "(no subject)"}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-2 font-mono text-data text-text-muted">
            <span>drafted {formatDateTime(draft.createdAt)}</span>
            {draft.client && <Tag>{draft.client}</Tag>}
            {!pending && <Tag tone={draft.status === "sent" ? "success" : "neutral"}>{draft.status}</Tag>}
          </p>
        </div>
      </header>

      <div className="rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-5 py-4">
          <Envelope draft={draft} />
        </div>
        <div className="px-5 py-5">
          <Body text={draft.body} />
        </div>
      </div>

      {pending ? (
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
          <ConfirmDialog
            triggerLabel="Discard"
            triggerVariant="secondary"
            title="Discard this draft?"
            action={discardDraftAction}
            fields={{ id: draft.id }}
            confirmLabel="Discard draft"
            confirmVariant="danger"
            pendingLabel="Discarding…"
          >
            <p className="text-body text-text-muted">
              It stops appearing on your devices. Nothing is sent, and the copy in Gmail Drafts stays where it is.
            </p>
          </ConfirmDialog>
          <ConfirmDialog
            triggerLabel="Approve and send"
            title="Send this email?"
            action={approveDraftAction}
            fields={{ id: draft.id, confirmation: draftFingerprint(draft) }}
            confirmName="confirm"
            confirmValue={CONFIRM_VALUE}
            confirmLabel="Send email"
            pendingLabel="Sending…"
          >
            <div className="flex flex-col gap-4">
              <Envelope draft={draft} />
              <div className="max-h-[40dvh] overflow-y-auto rounded-md border border-line bg-surface-sunken px-4 py-3">
                <Body text={draft.body} />
              </div>
              <p className="text-small text-text-muted">This sends from your Gmail right away. It can't be unsent.</p>
            </div>
          </ConfirmDialog>
        </div>
      ) : (
        <p className="mt-6 text-body text-text-muted">
          {draft.status === "sent" ? `Sent ${formatDateTime(draft.sentAt)}.` : "This draft was discarded. Nothing was sent."}
        </p>
      )}
    </article>
  );
}
