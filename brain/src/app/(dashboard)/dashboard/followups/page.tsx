import type { Metadata } from "next";
import { Badge, Tag } from "@/components/ui/Badge";
import { ButtonLink } from "@/components/ui/Button";
import { CopyButton } from "@/components/ui/CopyButton";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListRow } from "@/components/ui/ListRow";
import { PageHeader } from "@/components/ui/PageHeader";
import { getDeps } from "@/lib/deps";
import { plural } from "@/lib/dashboard/format";
import { requireOwnerSession } from "@/lib/dashboard/owner";

export const metadata: Metadata = { title: "Follow-ups" };
export const dynamic = "force-dynamic";

export default async function FollowUpsPage() {
  await requireOwnerSession();
  const deps = getDeps();
  const items = await deps.repos.followups.list();
  const pending = new Set((await deps.repos.drafts.listPending()).map((d) => d.id));

  return (
    <>
      <PageHeader
        title="Follow-ups"
        lede={items.length ? `${plural(items.length, "person", "people")} to get back to, most important first.` : undefined}
      />
      {items.length === 0 ? (
        <EmptyState title="No follow-ups waiting">
          SideKiqq adds people here when a thread goes quiet, a proposal is outstanding, or someone is waiting on you.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {items.map((f) => {
            const draftReady = f.draftId && pending.has(f.draftId);
            return (
              <ListRow
                key={f.id}
                importance={f.importance}
                title={f.person}
                badges={
                  <>
                    <Badge importance={f.importance} />
                    {f.client && <Tag>{f.client}</Tag>}
                  </>
                }
                detail={f.reason}
                meta={f.daysQuiet !== undefined ? `quiet for ${plural(f.daysQuiet, "day")}` : undefined}
                actions={
                  draftReady ? (
                    <ButtonLink href={`/dashboard/drafts/${encodeURIComponent(f.draftId!)}`} variant="primary" size="sm">
                      Review draft
                    </ButtonLink>
                  ) : f.suggestedMessage ? (
                    <CopyButton text={f.suggestedMessage} />
                  ) : undefined
                }
              >
                {f.suggestedMessage && (
                  <figure className="mt-3 rounded-md border-l-2 border-line-strong bg-surface-sunken px-4 py-3">
                    <figcaption className="mb-1 text-small font-medium text-text-muted">Suggested message</figcaption>
                    <blockquote className="whitespace-pre-wrap text-body text-text">{f.suggestedMessage}</blockquote>
                  </figure>
                )}
                {!draftReady && (
                  <p className="mt-2 text-small text-text-muted">
                    No draft yet. Ask SideKiqq on any device to “draft the follow-up to {f.person}” and it will appear in Drafts.
                  </p>
                )}
              </ListRow>
            );
          })}
        </ul>
      )}
    </>
  );
}
