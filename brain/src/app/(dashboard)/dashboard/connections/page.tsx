import type { Metadata } from "next";
import { Tag } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cx } from "@/components/ui/cx";
import { EmptyState } from "@/components/ui/EmptyState";
import { Notice } from "@/components/ui/Notice";
import { PageHeader } from "@/components/ui/PageHeader";
import { getDeps } from "@/lib/deps";
import { listConnections, type Connection, type ConnectionCapability } from "@/lib/connectors/manage";
import { connectionActions, connectionsNotice, STATUS_PRESENTATION } from "@/lib/dashboard/connections";
import { formatDateTime } from "@/lib/dashboard/format";
import { requireOwnerSession } from "@/lib/dashboard/owner";
import { connectConnectorAction, disconnectConnectorAction, setCapabilityAction } from "../actions";

export const metadata: Metadata = { title: "Connections" };
export const dynamic = "force-dynamic";

function Toggle({ connectorId, cap }: { connectorId: string; cap: ConnectionCapability }) {
  const on = cap.ownerEnabled;
  return (
    <form action={setCapabilityAction}>
      <input type="hidden" name="connectorId" value={connectorId} />
      <input type="hidden" name="capability" value={cap.id} />
      <input type="hidden" name="on" value={on ? "0" : "1"} />
      <button
        type="submit"
        role="switch"
        aria-checked={on}
        aria-label={`${cap.label}: ${on ? "on" : "off"}`}
        className={cx(
          "inline-flex min-h-touch items-center gap-2 rounded-md px-2 text-small font-medium transition-colors duration-fast",
          "focus-visible:outline-accent hover:bg-surface-sunken",
          on ? "text-text" : "text-text-muted",
        )}
      >
        <span aria-hidden className={cx("relative inline-block h-5 w-9 rounded-pill transition-colors duration-fast", on ? "bg-accent" : "bg-line-strong")}>
          <span className={cx("absolute top-0.5 h-4 w-4 rounded-pill bg-surface transition-[left] duration-fast", on ? "left-[1.125rem]" : "left-0.5")} />
        </span>
        {on ? "On" : "Off"}
      </button>
    </form>
  );
}

function CapabilityRow({ c, cap, toggles }: { c: Connection; cap: ConnectionCapability; toggles: boolean }) {
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-body text-text">{cap.label}</p>
        <p className="mt-1 flex flex-wrap items-center gap-2">
          <Tag tone={cap.tier === "auto" ? "neutral" : "accent"}>{cap.tierLabel}</Tag>
          {c.status !== "not_connected" && cap.ownerEnabled && !cap.granted && (
            <span className="text-small text-danger-ink">Permission not granted. Reconnect to allow it.</span>
          )}
        </p>
      </div>
      {toggles && <Toggle connectorId={c.connectorId} cap={cap} />}
    </li>
  );
}

function ConnectionCard({ c }: { c: Connection }) {
  const status = STATUS_PRESENTATION[c.status];
  const actions = connectionActions(c);
  return (
    <Card title={c.displayName} aside={<Tag tone={status.tone}>{status.label}</Tag>}>
      <div className="flex flex-col gap-4">
        {(c.account || c.connectedAt || c.lastUsedAt) && (
          <p className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-data text-text-muted">
            {c.account && <span className="text-text">{c.account}</span>}
            {c.connectedAt && <span>connected {formatDateTime(c.connectedAt)}</span>}
            <span>{c.lastUsedAt ? `last used ${formatDateTime(c.lastUsedAt)}` : "not used recently"}</span>
          </p>
        )}
        {c.lastError && <p className="text-body text-danger-ink">{c.lastError}</p>}
        {c.status === "needs_reauth" && (
          <p className="text-body text-text-muted">SideKiqq stopped using this account because the sign-in stopped working. Reconnect to turn it back on.</p>
        )}

        <ul className="divide-y divide-line border-y border-line">
          {c.capabilities.map((cap) => (
            <CapabilityRow key={cap.id} c={c} cap={cap} toggles={actions.toggles} />
          ))}
        </ul>

        <div className="flex flex-wrap gap-2">
          {actions.connect && (
            <form action={connectConnectorAction}>
              <input type="hidden" name="connectorId" value={c.connectorId} />
              <button type="submit" className={buttonClass(actions.connectPrimary ? "primary" : "secondary", "md")}>
                {actions.connect}
              </button>
            </form>
          )}
          {actions.disconnect && (
            <ConfirmDialog
              triggerLabel="Disconnect"
              triggerVariant="ghost"
              title={`Disconnect ${c.displayName}?`}
              action={disconnectConnectorAction}
              fields={{ connectorId: c.connectorId }}
              confirmName="confirm"
              confirmValue="disconnect"
              confirmLabel="Disconnect"
              confirmVariant="danger"
              pendingLabel="Disconnecting…"
            >
              <p className="text-body text-text-muted">
                SideKiqq revokes its access{c.account ? ` to ${c.account}` : ""} and deletes the stored sign-in. Your email, calendar and files are not touched. Pending drafts stay pending and can't be sent until you connect again.
              </p>
            </ConfirmDialog>
          )}
        </div>
      </div>
    </Card>
  );
}

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string; connect?: string }> }) {
  await requireOwnerSession();
  const notice = connectionsNotice(await searchParams);
  let items: Connection[] = [];
  let loadError = false;
  try {
    items = await listConnections(getDeps());
  } catch (err) {
    console.error("[dashboard] connections failed", err);
    loadError = true;
  }

  return (
    <>
      <PageHeader
        title="Connections"
        lede="The accounts SideKiqq can use, and what it may do with each. How each permission runs is fixed: sending is never a switch here, and every message waits for your approval in Drafts."
      />
      {notice && (
        <div className="mb-6">
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      )}
      {loadError ? (
        <EmptyState title="Connections unavailable">The data store didn&apos;t respond. Reload in a minute.</EmptyState>
      ) : items.length === 0 ? (
        <EmptyState title="No services available">This brain has no connectors configured.</EmptyState>
      ) : (
        <div className="flex flex-col gap-6">
          {items.map((c) => (
            <ConnectionCard key={c.connectorId} c={c} />
          ))}
        </div>
      )}
    </>
  );
}
