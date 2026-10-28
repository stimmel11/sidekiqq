import type { Deps } from "../deps";
import { truncate } from "../util";
import {
  BACKGROUND_ALLOWED,
  INPUT_SCHEMAS,
  isCapabilityId,
  OWNER_INITIATED,
  POLICY,
  READ_ONLY,
  type CapabilityId,
  type EmailReadIn,
  type EmailReadOutput,
  type ImplementedCapability,
  type In,
  type Out,
} from "./capabilities";
import { CapabilityDeniedError, CapabilityUnavailableError, type ConnCtx, type Connector } from "./types";

/**
 * THE ONLY CALLER OF `Connector.invoke` (docs/CONNECTORS.md §4). Enforced by test/connectors.test.ts.
 *
 *  1. The capability must be in the fixed POLICY table (no executors, no invented names).
 *  2. Background callers (cron, brief) may only use BACKGROUND_ALLOWED reads.
 *  3. Auto writes and handoffs need an owner-initiated caller (ask, task, dashboard).
 *  4. `confirm` and `user_finishes` never run here. Their prepare/handoff paths arrive with the
 *     calendar and device-queue items; until then they fail closed.
 *  5. Input is validated against the capability's schema before any connector sees it.
 *  6. Every attempted call that reaches a connector writes an audit row (best effort).
 *
 * Not yet enforced (next slice, with ConnectionStore): per-connection enabled capabilities.
 */

function implemented(cap: CapabilityId): cap is ImplementedCapability {
  return Object.prototype.hasOwnProperty.call(INPUT_SCHEMAS, cap);
}

function summarize(cap: CapabilityId, input: unknown): string {
  const i = input as Record<string, unknown>;
  switch (cap) {
    case "email.read":
      return `${String(i.op)}${typeof i.query === "string" ? ` "${i.query}"` : ""}`;
    case "email.draft":
      return `draft to ${(i.to as string[]).join(", ")}: "${String(i.subject)}"`;
    case "calendar.read":
      return `${String(i.timeMin)} → ${String(i.timeMax)}`;
    case "files.read":
      return `search "${String(i.query)}"`;
    case "contacts.lookup":
      return `lookup "${String(i.name)}"`;
    default:
      return cap;
  }
}

/** Argument fields never written to the audit log, whatever the connector (§4: never a full email body). */
const REDACTED_ARGS = new Set(["body", "content", "password", "token"]);

function auditArgs(data: unknown): string {
  return truncate(JSON.stringify(data, (k, v) => (REDACTED_ARGS.has(k) ? "[redacted]" : v)), 1000);
}

export function connectorFor(connectors: readonly Connector[], cap: CapabilityId): Connector | undefined {
  return connectors.find((c) => c.capabilities.includes(cap));
}

export async function invokeCapability<C extends ImplementedCapability>(deps: Deps, cap: C, input: In<C>, ctx: ConnCtx): Promise<Out<C>>;
export async function invokeCapability(deps: Deps, cap: string, input: unknown, ctx: ConnCtx): Promise<unknown>;
export async function invokeCapability(deps: Deps, cap: string, input: unknown, ctx: ConnCtx): Promise<unknown> {
  if (!isCapabilityId(cap)) throw new CapabilityDeniedError(cap, "not a capability");
  const tier = POLICY[cap];
  const background = !OWNER_INITIATED.includes(ctx.caller);

  if (background && !BACKGROUND_ALLOWED.includes(cap)) {
    throw new CapabilityDeniedError(cap, `not allowed for background caller "${ctx.caller}"`);
  }
  if (tier === "confirm") throw new CapabilityDeniedError(cap, "needs the owner's confirmation and must be prepared as a draft");
  if (tier === "user_finishes") throw new CapabilityDeniedError(cap, "the owner finishes this on the phone; handoffs are not available yet");
  if (!READ_ONLY.includes(cap) && background) throw new CapabilityDeniedError(cap, "writes need an owner request");

  if (!implemented(cap)) throw new CapabilityUnavailableError(cap);
  const connector = connectorFor(deps.connectors(), cap);
  if (!connector) throw new CapabilityUnavailableError(cap);

  const parsed = INPUT_SCHEMAS[cap].safeParse(input);
  if (!parsed.success) {
    throw new CapabilityDeniedError(cap, `invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }

  const audit = async (ok: boolean, error?: string) => {
    await deps.repos.audit
      .add({
        connector: connector.id,
        capability: cap,
        tier,
        caller: ctx.caller,
        ...(ctx.device ? { device: ctx.device } : {}),
        summary: truncate(summarize(cap, parsed.data), 300),
        ...(connector.firstParty ? {} : { args: auditArgs(parsed.data) }),
        ok,
        ...(error ? { error: truncate(error, 300) } : {}),
      })
      .catch((err: unknown) => console.warn("[audit] write failed", err));
  };

  try {
    const out = await connector.invoke(cap, parsed.data as In<typeof cap>, ctx);
    await audit(true);
    return out;
  } catch (err) {
    await audit(false, (err as Error)?.message ?? String(err));
    throw err;
  }
}

/** Typed helper for the multi-op `email.read` capability. */
export function readEmail<I extends EmailReadIn>(deps: Deps, input: I, ctx: ConnCtx): Promise<EmailReadOutput<I>> {
  return invokeCapability(deps, "email.read", input, ctx) as Promise<EmailReadOutput<I>>;
}
