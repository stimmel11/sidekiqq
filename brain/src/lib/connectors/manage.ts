import type { Deps } from "../deps";
import { HttpError } from "../http";
import { CAPABILITY_LABEL, isCapabilityId, POLICY, TIER_LABEL, type CapabilityId, type Tier } from "./capabilities";
import { oauthFlow } from "./oauth";
import { effectiveCapabilities, type StoredConnection } from "./store";
import type { Connector } from "./types";

/**
 * The owner's view of connections (docs/CONNECTORS.md §9): shared by `/api/connections` and the
 * dashboard Connections screen. Owner-only; never reachable with a device token.
 *
 * Tiers are read from the fixed POLICY table and are never editable here. The only thing the owner
 * can change is which of a connector's own capabilities are on, and none of them is a send path
 * (executors are not capabilities at all, see ./capabilities.ts).
 */

export type ConnectionStatus = "connected" | "needs_reauth" | "error" | "disabled" | "not_connected";

export interface ConnectionCapability {
  id: CapabilityId;
  /** Usable now: the owner turned it on AND the provider granted its permission. */
  enabled: boolean;
  tier: Tier;
  /** The owner's switch, whatever the provider granted. */
  ownerEnabled: boolean;
  /** The provider granted the scopes it needs (true when the granted scopes are unknown). */
  granted: boolean;
  /** Plain words: what it does, and how its tier runs. */
  label: string;
  tierLabel: string;
}

export interface Connection {
  connectorId: string;
  displayName: string;
  status: ConnectionStatus;
  account?: string;
  capabilities: ConnectionCapability[];
  connectedAt?: string;
  lastUsedAt?: string;
  lastError?: string;
}

const UNREADABLE = "The stored sign-in could not be read (the encryption key changed or the record is damaged). Reconnect to fix it.";

export function findConnector(deps: Deps, connectorId: string): Connector {
  const c = deps.connectors().find((x) => x.id === connectorId);
  if (!c) throw new HttpError(404, `Unknown connector "${connectorId.slice(0, 40)}"`, "unknown_connector");
  return c;
}

function view(connector: Connector, stored: StoredConnection | null, unreadable: boolean, lastUsedAt?: string): Connection {
  const effective = stored ? effectiveCapabilities(connector, stored) : [];
  const ownerOn = stored?.enabled ?? [...connector.capabilities];
  const granted = new Set(stored?.grantedScopes ?? []);
  const capabilities = connector.capabilities.map((id): ConnectionCapability => {
    const tier = POLICY[id];
    return {
      id,
      enabled: effective.includes(id),
      tier,
      ownerEnabled: ownerOn.includes(id),
      granted: !stored || granted.size === 0 || connector.scopesFor([id]).every((s) => granted.has(s)),
      label: CAPABILITY_LABEL[id],
      tierLabel: TIER_LABEL[tier],
    };
  });
  let status: ConnectionStatus;
  if (!stored) status = unreadable ? "error" : "not_connected";
  else if (stored.status === "needs_reauth") status = "needs_reauth";
  else if (effective.length === 0) status = "disabled";
  else status = "connected";
  const lastError = unreadable && !stored ? UNREADABLE : stored?.lastError;
  return {
    connectorId: connector.id,
    displayName: connector.displayName,
    status,
    ...(stored?.account ? { account: stored.account } : {}),
    capabilities,
    ...(stored ? { connectedAt: stored.connectedAt } : {}),
    ...(stored && lastUsedAt ? { lastUsedAt } : {}),
    ...(lastError && status !== "connected" ? { lastError } : {}),
  };
}

/** Newest successful audited call per connector (the audit log is bounded, so this may be absent). */
async function lastUsed(deps: Deps): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for (const row of await deps.repos.audit.recent(1000)) if (row.ok && !out.has(row.connector)) out.set(row.connector, row.at);
  } catch (err) {
    console.warn("[connections] could not read the audit log", err);
  }
  return out;
}

async function loadView(deps: Deps, connector: Connector, used?: Map<string, string>): Promise<Connection> {
  const stored = await deps.connections.load(connector.id);
  const unreadable = !stored && (await deps.connections.hasRecord(connector.id));
  return view(connector, stored, unreadable, (used ?? (await lastUsed(deps))).get(connector.id));
}

export async function listConnections(deps: Deps): Promise<Connection[]> {
  const used = await lastUsed(deps);
  return Promise.all(deps.connectors().map((c) => loadView(deps, c, used)));
}

export async function getConnection(deps: Deps, connectorId: string): Promise<Connection> {
  return loadView(deps, findConnector(deps, connectorId));
}

/**
 * Sets the owner's enabled list. Every id must be one of this connector's capabilities; anything
 * else (an executor such as `email.send`, another connector's capability, an invented name) is a 400.
 */
export async function setCapabilities(deps: Deps, connectorId: string, enabled: readonly string[]): Promise<Connection> {
  const connector = findConnector(deps, connectorId);
  const bad = enabled.filter((c) => !isCapabilityId(c) || !connector.capabilities.includes(c));
  if (bad.length) throw new HttpError(400, `${connector.id} does not offer: ${bad.map((b) => b.slice(0, 60)).join(", ")}`, "unknown_capability");
  const saved = await deps.connections.setEnabled(connector, enabled as CapabilityId[]);
  if (!saved) throw new HttpError(409, `${connector.displayName} is not connected.`, "not_connected");
  return getConnection(deps, connector.id);
}

/** Turns one capability on or off, keeping the others as they are. */
export async function setCapability(deps: Deps, connectorId: string, cap: string, on: boolean): Promise<Connection> {
  const connector = findConnector(deps, connectorId);
  const stored = await deps.connections.load(connector.id);
  if (!stored) throw new HttpError(409, `${connector.displayName} is not connected.`, "not_connected");
  // Drop stale ids (e.g. a capability the connector no longer offers) so they can't block every toggle.
  const current = (stored.enabled ?? [...connector.capabilities]).filter((c) => connector.capabilities.includes(c));
  const next = on ? [...current, cap] : current.filter((c) => c !== cap);
  return setCapabilities(deps, connector.id, next);
}

/**
 * Disconnect (§7): delete the stored credential first, then revoke it at the provider where it has
 * an endpoint (best effort, with the secret read before the delete). Deleting first means a call
 * that fails mid-revoke finds no stored connection, so it can't mark it needs_reauth or alert the
 * owner, and a failed delete never leaves a dead credential behind a "couldn't disconnect" error.
 * A connection that already needs reauth is not revoked: its grant is already dead.
 */
export async function disconnect(deps: Deps, connectorId: string): Promise<{ ok: true; revoked: boolean }> {
  const connector = findConnector(deps, connectorId);
  const stored = await deps.connections.load(connector.id);
  await deps.connections.clear(connector.id);
  if (stored?.status === "needs_reauth") return { ok: true, revoked: true };
  let revoked = false;
  const flow = oauthFlow(connector.id);
  if (stored && stored.secretKind === "refresh_token" && flow?.revoke) {
    try {
      await flow.revoke(stored.secret);
      revoked = true;
    } catch (err) {
      // Google answers invalid_token / invalid_grant for a token that is already revoked or expired.
      if (/invalid_(token|grant)/.test(String((err as { response?: { data?: { error?: unknown } } })?.response?.data?.error ?? (err as Error)?.message))) {
        revoked = true;
      } else {
        console.warn(`[connections] ${connector.id}: provider revoke failed; the local credential was deleted`, (err as Error)?.message);
      }
    }
  }
  return { ok: true, revoked };
}

/** Provider consent URL for a connector that has an OAuth flow. */
export async function startConnect(deps: Deps, connectorId: string): Promise<string> {
  const connector = findConnector(deps, connectorId);
  const flow = oauthFlow(connector.id);
  if (!flow) throw new HttpError(400, `${connector.displayName} can't be connected from here yet.`, "no_oauth_flow");
  return flow.authUrl(deps);
}
