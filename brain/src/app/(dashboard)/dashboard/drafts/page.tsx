import type { Metadata } from "next";
import Link from "next/link";
import { Tag } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { getDeps } from "@/lib/deps";
import { formatDateTime, plural } from "@/lib/dashboard/format";
import { requireOwnerSession } from "@/lib/dashboard/owner";

export const metadata: Metadata = { title: "Drafts" };
export const dynamic = "force-dynamic";

const DONE: Record<string, string> = {
  sent: "Sent. The email went out from your Gmail and the follow-up is closed.",
  discarded: "Discarded. Nothing was sent; the Gmail copy is still in your Drafts folder.",
};

export default async function DraftsPage({ searchParams }: { searchParams: Promise<{ done?: string }> }) {
  await requireOwnerSession();
  const done = DONE[(await searchParams).done ?? ""];
  const drafts = (await getDeps().repos.drafts.listPending()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  return (
    <>
      <PageHeader
        title="Drafts"
        lede={
          drafts.length
            ? `${plural(drafts.length, "draft")} waiting for your approval. Nothing is sent until you approve it.`
            : "Nothing is sent until you approve it."
        }
      />
      {done && (
        <div className="mb-6">
          <Notice>{done}</Notice>
        </div>
      )}
      {drafts.length === 0 ? (
        <EmptyState title="No drafts waiting">Drafts SideKiqq writes for you, from follow-ups or a voice request, wait here for approval.</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {drafts.map((d) => (
            <li key={d.id}>
              <Link
                href={`/dashboard/drafts/${encodeURIComponent(d.id)}`}
                className="group flex flex-col gap-1 px-5 py-4 transition-colors duration-fast hover:bg-surface-sunken focus-visible:-outline-offset-2"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-heading text-h3 text-text group-hover:underline">{d.subject || "(no subject)"}</span>
                  {d.client && <Tag>{d.client}</Tag>}
                </span>
                <span className="text-body text-text-muted">To {d.to.join(", ")}</span>
                <span className="line-clamp-2 text-small text-text-muted">{d.body}</span>
                <span className="mt-1 font-mono text-data text-text-muted">drafted {formatDateTime(d.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
