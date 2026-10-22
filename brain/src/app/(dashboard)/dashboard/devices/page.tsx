import type { Metadata } from "next";
import { Tag } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListRow } from "@/components/ui/ListRow";
import { PageHeader } from "@/components/ui/PageHeader";
import { getDeps } from "@/lib/deps";
import { DASHBOARD_DEVICE_NAME } from "@/lib/dashboard/device-bridge";
import { formatDateTime } from "@/lib/dashboard/format";
import { requireOwnerSession } from "@/lib/dashboard/owner";
import { PairCode } from "./PairCode";

export const metadata: Metadata = { title: "Devices" };
export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = { phone: "Phone", watch: "Galaxy Watch", glasses: "Galaxy Glasses", medallion: "Medallion" };

export default async function DevicesPage() {
  await requireOwnerSession();
  let devices: Awaited<ReturnType<ReturnType<typeof getDeps>["repos"]["devices"]["list"]>> = [];
  let listError = false;
  try {
    devices = (await getDeps().repos.devices.list()).filter((d) => !d.revoked);
  } catch {
    listError = true;
  }
  devices.sort((a, b) => Date.parse(b.lastSeenAt ?? b.createdAt) - Date.parse(a.lastSeenAt ?? a.createdAt));

  return (
    <>
      <PageHeader title="Devices" lede="Pair a phone, watch, glasses or medallion with a one-time code." />
      <Card title="Pair a device" className="mb-8">
        <PairCode />
      </Card>

      <h2 className="mb-3 font-heading text-h2">Paired devices</h2>
      {listError ? (
        <EmptyState title="Device list unavailable">The data store didn't respond. Reload in a minute.</EmptyState>
      ) : devices.length === 0 ? (
        <EmptyState title="No devices paired yet">Create a code above, then enter it in the SideKiqq app on the device.</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {devices.map((d) => (
            <ListRow
              key={d.id}
              title={d.name ?? KIND_LABEL[d.kind] ?? d.kind}
              badges={
                <>
                  <Tag>{KIND_LABEL[d.kind] ?? d.kind}</Tag>
                  {d.name === DASHBOARD_DEVICE_NAME && <Tag tone="accent">this dashboard</Tag>}
                  {d.fcmToken && <Tag tone="success">alerts on</Tag>}
                </>
              }
              meta={
                <span className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>paired {formatDateTime(d.createdAt)}</span>
                  <span>{d.lastSeenAt ? `last seen ${formatDateTime(d.lastSeenAt)}` : "not seen yet"}</span>
                </span>
              }
            />
          ))}
        </ul>
      )}
      <p className="mt-3 text-small text-text-muted">Revoking a lost device from here is planned; see the backlog in PROGRESS.md.</p>
    </>
  );
}
