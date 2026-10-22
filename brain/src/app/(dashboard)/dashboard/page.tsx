import type { Metadata } from "next";
import { Suspense } from "react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { cx } from "@/components/ui/cx";
import { getDeps } from "@/lib/deps";
import { computeTop5, generateBrief } from "@/lib/briefing";
import { formatDay, formatDateTime, formatLongToday, sentenceCase } from "@/lib/dashboard/format";
import { requireOwnerSession } from "@/lib/dashboard/owner";
import { BriefKindSchema, type BriefKind, type TopItem } from "@/lib/models";

export const metadata: Metadata = { title: "Today" };
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KINDS: { value: BriefKind; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "eod", label: "End of day" },
  { value: "weekly", label: "Weekly" },
];

function TopFive({ items }: { items: TopItem[] }) {
  if (!items.length) {
    return (
      <EmptyState title="Nothing needs you right now">
        No open commitments, follow-ups or drafts are waiting. New items appear after the next inbox scan.
      </EmptyState>
    );
  }
  return (
    <ol className="divide-y divide-line border-y border-line">
      {items.map((item, i) => (
        <li key={item.id} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4 py-4 sm:grid-cols-[3.5rem_minmax(0,1fr)_auto]">
          <span
            aria-hidden
            className={cx(
              "font-heading text-[2.25rem] font-semibold leading-none tracking-[-0.04em] sm:text-[2.75rem]",
              item.importance === "CRITICAL" ? "text-danger" : item.importance === "HIGH" ? "text-accent" : "text-text-faint",
            )}
          >
            {i + 1}
          </span>
          <div className="min-w-0">
            <h3 className="font-heading text-h3 text-text">
              <span className="sr-only">{i + 1}. </span>
              {item.title}
            </h3>
            <p className="mt-0.5 text-body text-text-muted">{item.why}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 sm:hidden">
              <Badge importance={item.importance} />
              {item.dueAt && <span className="font-mono text-data text-text-muted">due {formatDay(item.dueAt)}</span>}
            </div>
          </div>
          <div className="hidden flex-col items-end gap-2 sm:flex">
            <Badge importance={item.importance} />
            {item.dueAt && <span className="font-mono text-data text-text-muted">due {formatDay(item.dueAt)}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

async function TopFiveSection() {
  try {
    const { items, updatedAt } = await computeTop5(getDeps());
    return (
      <section aria-labelledby="top5" className="mb-10">
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h2 id="top5" className="font-heading text-h2">
            Top 5 actions
          </h2>
          <span className="font-mono text-data text-text-muted">updated {formatDateTime(updatedAt)}</span>
        </div>
        <TopFive items={items} />
      </section>
    );
  } catch (err) {
    console.error("[dashboard] top5 failed", err);
    return (
      <EmptyState title="Top 5 is unavailable">The brain couldn't read its data store. Check the Upstash Redis variables, then reload.</EmptyState>
    );
  }
}

async function BriefSections({ kind }: { kind: BriefKind }) {
  let brief;
  try {
    brief = await generateBrief(getDeps(), kind);
  } catch (err) {
    console.error("[dashboard] brief failed", err);
    return <EmptyState title="The brief couldn't be built">The data store didn't respond. Reload in a minute.</EmptyState>;
  }
  if (!brief.sections.length) {
    return <EmptyState title="A quiet brief">Nothing in your commitments, follow-ups, calendar or drafts made it into this brief.</EmptyState>;
  }
  return (
    <>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {brief.sections.map((s) => (
          <Card key={s.title} title={sentenceCase(s.title)} aside={<span className="font-mono text-data">{s.items.length}</span>} flush>
            {s.items.length ? (
              <ul className="divide-y divide-line border-t border-line">
                {s.items.map((it, i) => (
                  <li key={i} className="px-5 py-3 text-body text-text">
                    {it}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 pb-4 text-body text-text-muted">Nothing here.</p>
            )}
          </Card>
        ))}
      </div>
      <p className="mt-3 font-mono text-data text-text-muted">generated {formatDateTime(brief.generatedAt)}</p>
    </>
  );
}

function BriefSkeleton() {
  return (
    <div role="status" className="grid gap-4 lg:grid-cols-2">
      <span className="sr-only">Writing your brief…</span>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} aria-hidden className="h-40 rounded-lg border border-line bg-surface motion-safe:animate-pulse" />
      ))}
    </div>
  );
}

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  await requireOwnerSession();
  const parsed = BriefKindSchema.safeParse((await searchParams).kind ?? "daily");
  const kind = parsed.success ? parsed.data : "daily";
  return (
    <>
      <PageHeader title="Today" lede={formatLongToday()} />
      <Suspense fallback={<div aria-hidden className="mb-10 h-72 rounded-lg bg-surface-sunken motion-safe:animate-pulse" />}>
        <TopFiveSection />
      </Suspense>
      <section aria-labelledby="brief">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="brief" className="font-heading text-h2">
            Brief
          </h2>
          <Segmented
            label="Brief type"
            current={kind}
            items={KINDS.map((k) => ({ ...k, href: k.value === "daily" ? "/dashboard" : `/dashboard?kind=${k.value}` }))}
          />
        </div>
        <Suspense key={kind} fallback={<BriefSkeleton />}>
          <BriefSections kind={kind} />
        </Suspense>
      </section>
    </>
  );
}
