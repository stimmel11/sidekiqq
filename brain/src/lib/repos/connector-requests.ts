import type { KV } from "../kv";
import {
  CLOSED_CONNECTOR_REQUEST_STATUSES,
  ConnectorRequestSchema,
  type ConnectorRequest,
  type ConnectorRequestStatus,
  type CreateConnectorRequest,
  type DeviceKind,
  type UpdateConnectorRequest,
} from "../models";
import { ConnectorRequestError, MAX_OPEN_CONNECTOR_REQUESTS, serviceKey } from "../connectors/requests";
import { newId } from "../util";
import { Collection } from "./collection";

export type ConnectorRequestSource = { kind: "voice"; device: DeviceKind } | { kind: "owner" };

const isOpen = (r: ConnectorRequest) => !CLOSED_CONNECTOR_REQUEST_STATUSES.includes(r.status);
/** Statuses that point at a pull request, so they need `prUrl`. */
const NEEDS_PR: readonly ConnectorRequestStatus[] = ["in_review", "live"];

/**
 * Connector requests (one Redis hash). Pure bookkeeping: nothing here builds, connects or enables
 * a connector. Asking again for a service with an open request bumps `requestCount` instead of
 * adding a row.
 */
export class ConnectorRequestsRepo {
  private readonly col: Collection<ConnectorRequest>;

  constructor(kv: KV, prefix: string, private readonly clock: () => Date = () => new Date()) {
    this.col = new Collection(kv, prefix, "connector_requests", ConnectorRequestSchema);
  }

  /** Input must already be validated with `CreateConnectorRequestSchema`. */
  async add(input: CreateConnectorRequest, source: ConnectorRequestSource): Promise<{ request: ConnectorRequest; created: boolean }> {
    const key = serviceKey(input.service);
    if (!key) throw new ConnectorRequestError("service name is empty", "invalid", 400);
    const now = this.clock().toISOString();
    const all = await this.col.all();
    const open = all.filter(isOpen);
    const existing = open.find((r) => r.serviceKey === key);
    if (existing) {
      const request = await this.col.put({ ...existing, requestCount: existing.requestCount + 1, updatedAt: now });
      return { request, created: false };
    }
    if (open.length >= MAX_OPEN_CONNECTOR_REQUESTS) {
      throw new ConnectorRequestError(
        `There are already ${open.length} open connector requests. Decline or finish some first.`,
        "too_many_open",
        429,
      );
    }
    const request = await this.col.put({
      id: newId("creq"),
      service: input.service,
      serviceKey: key,
      purpose: input.purpose,
      category: input.category,
      status: "new",
      source: source.kind === "voice" ? { kind: "voice", device: source.device } : { kind: "owner" },
      requestCount: 1,
      createdAt: now,
      updatedAt: now,
    });
    return { request, created: true };
  }

  get(id: string) {
    return this.col.get(id);
  }

  /** Newest first. `status` filters to one status. */
  async list(opts: { status?: ConnectorRequestStatus } = {}): Promise<ConnectorRequest[]> {
    return (await this.col.all())
      .filter((r) => !opts.status || r.status === opts.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  /** Owner bookkeeping. `null` clears `prUrl` / `note`. In review and live need a PR link. */
  async update(id: string, patch: UpdateConnectorRequest): Promise<ConnectorRequest> {
    const current = await this.col.get(id);
    if (!current) throw new ConnectorRequestError("no such connector request", "not_found", 404);
    const next: ConnectorRequest = { ...current, updatedAt: this.clock().toISOString() };
    if (patch.status !== undefined) next.status = patch.status;
    if (patch.prUrl === null) delete next.prUrl;
    else if (patch.prUrl !== undefined) next.prUrl = patch.prUrl;
    if (patch.note === null || patch.note === "") delete next.note;
    else if (patch.note !== undefined) next.note = patch.note;
    if (NEEDS_PR.includes(next.status) && !next.prUrl) {
      throw new ConnectorRequestError(`status "${next.status}" needs a prUrl`, "needs_pr_url", 400);
    }
    // Re-opening a closed request must not create a duplicate open one for the same service.
    if (!isOpen(current) && isOpen(next)) {
      const clash = (await this.col.all()).find((r) => r.id !== id && isOpen(r) && r.serviceKey === current.serviceKey);
      if (clash) throw new ConnectorRequestError(`request ${clash.id} is already open for this service`, "invalid", 409);
    }
    return this.col.put(next);
  }
}
