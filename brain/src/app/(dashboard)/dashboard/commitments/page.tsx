import type { Metadata } from "next";
import { Tag } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListRow } from "@/components/ui/ListRow";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { getDeps } from "@/lib/deps";
import { formatDay } from "@/lib/dashboard/format";
import { requireOwnerSession } from "@/lib/dashboard/owner";
import type { Commitment } from "@/lib/models";
import { completeCommitmentAction } from "../actions";

export const metadata: Metadata = { title: "Commitments" };
export const dynamic = "force-dynamic";

type Filter = "open" | "overdue" | "all";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "overdue", label: "Overdue" },
  { value: "all", label: "All" },
];

const EMPTY: Record<Filter, [string, string]> = {
  open: ["No open commitments", "Promises you or others make in email, meetings or voice notes show up here with their due dates."],
  overdue: ["Nothing overdue", "Every open commitment is still within its due date."],
  all: ["No commitments yet", "They appear after the first inbox scan or when you tell SideKiqq about a promise."],
};

function Due({ c }: { c: Commitment }) {
  if (!c.dueAt) return <span>no due date</span>;
  return (
    <span className={c.status === "overdue" ? "text-danger-ink" : undefined}>
      {c.status === "overdue" ? "overdue, was due " : "due "}
      {formatDay(c.dueAt)}
      {c.dueInferred && (
        <span className="ml-1.5 rounded-sm border border-dashed border-line-strong px-1 text-text-muted" title="SideKiqq guessed this date; nobody stated it.">
          inferred
        </span>
      )}
    </span>
  );
}

export default async function CommitmentsPage({ searchParams }: { searchParams: Promise<{ status?: string; done?: string }> }) {
  await requireOwnerSession();
  const sp = await searchParams;
  const filter: Filter = sp.status === "overdue" || sp.status === "all" ? sp.status : "open";
  const items = await getDeps().repos.commitments.list(filter);
  const [emptyTitle, emptyBody] = EMPTY[filter];

  return (
    <>
      <PageHeader
        title="Commitments"
        lede="Who promised what, and by when. Dates marked inferred were estimated, not stated."
        aside={
          <Segmented
            label="Commitment status"
            current={filter}
            items={FILTERS.map((f) => ({ ...f, href: `/dashboard/commitments?status=${f.value}` }))}
          />
        }
      />
      {sp.done === "completed" && (
        <div className="mb-6">
          <Notice>Marked complete.</Notice>
        </div>
      )}
      {sp.done === "error" && (
        <div className="mb-6">
          <Notice tone="danger">That commitment couldn't be updated. It may have been removed; reload and try again.</Notice>
        </div>
      )}
      {items.length === 0 ? (
        <EmptyState title={emptyTitle}>{emptyBody}</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {items.map((c) => (
            <ListRow
              key={c.id}
              importance={c.status === "overdue" ? "CRITICAL" : undefined}
              title={c.what}
              badges={
                <>
                  {c.status === "overdue" && <Tag tone="danger">overdue</Tag>}
                  {c.status === "done" && <Tag tone="success">done</Tag>}
                  {c.client && <Tag>{c.client}</Tag>}
                </>
              }
              detail={
                <>
                  {c.who}
                  {c.project ? `, ${c.project}` : ""}
                  {c.confidence !== "CONFIRMED" && <span className="text-text-muted"> ({c.confidence.toLowerCase()})</span>}
                </>
              }
              meta={
                <span className="flex flex-wrap gap-x-4 gap-y-1">
                  <Due c={c} />
                  <span>made {formatDay(c.madeAt)}</span>
                  <span>from {c.source.kind}</span>
                </span>
              }
              actions={
                c.status !== "done" ? (
                  <form action={completeCommitmentAction}>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="back" value={filter} />
                    <button type="submit" className={buttonClass("secondary", "sm")}>
                      Mark complete<span className="sr-only">: {c.what}</span>
                    </button>
                  </form>
                ) : undefined
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}
