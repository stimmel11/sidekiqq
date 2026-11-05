import type { Deps } from "../deps";
import { truncate } from "../util";
import { deliverAlert } from "../push/alerts";
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
  type ProviderOut,
} from "./capabilities";
import { buildReadback, READBACK_MAX_CHARS, ReadbackTooLongError } from "./readback";
import { effectiveCapabilities } from "./store";
import { CapabilityDeniedError, CapabilityUnavailableError, ConnectionUnusableError, ReauthRequiredError, type ConnCtx, type Connector } from "./types";

/**
 * THE ONLY CALLER OF `Connector.invoke` (docs/CONNECTORS.md §4). Enforced by test/connectors.test.ts.
 *
 *  1. The capability must be in the fixed POLICY table (no executors, no invented names).
 *  2. Background callers (cron, brief) may only use BACKGROUND_ALLOWED reads.
 *  3. Auto writes and handoffs need an owner-initiated caller (ask, task, dashboard).
 *  4. `confirm` and `user_finishes` never run here. Their prepare/handoff paths arrive with the
 *     calendar and device-queue items; until then they fail closed. The one exception is
 *     `device.call`, which has no connector: the /api/ask tool `call_on_phone` queues it directly
 *     (caller fixed to "ask", needs the owner request's context, number bound by
 *     lib/commands/call.ts, audited as `device.call`).
 *  5. Input is validated against the capability's schema before any connector sees it.
 *  6. The stored connection must be usable for this capability (§4 step 3): not `needs_reauth`,
 *     the capability enabled by the owner, and its scopes granted. With no stored connection the
 *     connector itself fails (e.g. GoogleNotConnectedError), as before.
 *  7. Every attempted call that reaches a connector writes an audit row (best effort).
 *  7a. `email.draft` also creates the pending Draft record with its code-built read-back
 *      (recordEmailDraft below). It still sends nothing; only the approve route executes drafts.
 *  8. A refresh failure (`invalid_grant`) marks the connection `needs_reauth` (§7) and, on that
 *     transition only, raises one owner alert (kind `connection_needs_reauth`).
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
    case "video.create_room":
      return `room "${String(i.topic)}"${typeof i.start === "string" ? ` at ${i.start}` : " (instant)"}`;
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
  if (tier === "user_finishes") {
    throw new CapabilityDeniedError(
      cap,
      cap === "device.call"
        ? "calls are handed off by the call_on_phone tool, not through invokeCapability"
        : "the owner finishes this on the phone; connector handoffs are not available yet",
    );
  }
  if (!READ_ONLY.includes(cap) && background) throw new CapabilityDeniedError(cap, "writes need an owner request");

  if (!implemented(cap)) throw new CapabilityUnavailableError(cap);
  const connector = connectorFor(deps.connectors(), cap);
  if (!connector) throw new CapabilityUnavailableError(cap);

  const parsed = INPUT_SCHEMAS[cap].safeParse(input);
  if (!parsed.success) {
    throw new CapabilityDeniedError(cap, `invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }

  if (cap === "email.draft") {
    // Refuse BEFORE a provider draft exists: a read-back the devices can't speak is never truncated.
    const i = parsed.data as In<"email.draft">;
    const rb = buildReadback({ kind: "email", to: i.to, cc: i.cc ?? [], subject: i.subject });
    if (rb.length > READBACK_MAX_CHARS) throw new CapabilityDeniedError(cap, new ReadbackTooLongError(rb.length).message);
  }

  const stored = await deps.connections.load(connector.id);
  if (stored) {
    if (stored.status === "needs_reauth") {
      throw new ConnectionUnusableError(cap, connector.id, "needs_reauth", `${connector.displayName} needs to be reconnected before SideKiqq can use it. Ask the owner to reconnect it.`);
    }
    if (!effectiveCapabilities(connector, stored).includes(cap)) {
      throw new ConnectionUnusableError(cap, connector.id, "disabled", `${cap} is turned off for ${connector.displayName}, or its permission was not granted. The owner can turn it on by reconnecting.`);
    }
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
    const provided = await connector.invoke(cap, parsed.data as In<typeof cap>, ctx);
    const out = cap === "email.draft" ? await recordEmailDraft(deps, connector.id, parsed.data as In<"email.draft">, provided as ProviderOut<"email.draft">) : provided;
    await audit(true);
    return out;
  } catch (err) {
    await audit(false, (err as Error)?.message ?? String(err));
    // A ReauthRequiredError from another connector's credential is not about this connection.
    const foreign = err instanceof ReauthRequiredError && err.connectorId !== connector.id;
    if (stored && !foreign && isInvalidGrant(err)) {
      const failedSecret = err instanceof ReauthRequiredError && err.failedSecret ? err.failedSecret : stored.secret;
      const marked = await deps.connections
        .markNeedsReauth(connector.id, "The provider rejected the stored sign-in.", failedSecret)
        .catch((e: unknown) => {
          console.warn("[connections] could not mark needs_reauth", e);
          return false;
        });
      // One owner alert, only on the transition to needs_reauth (§7).
      if (marked) await alertNeedsReauth(deps, connector);
    }
    throw err;
  }
}

/**
 * `email.draft` creates the provider draft (the connector) AND the pending Draft record (here),
 * so every connector gets the same record and the same code-built read-back (docs/CONNECTORS.md
 * §2, §5). The read-back is built by DraftsRepo.create from the structured fields; nothing the
 * model wrote is used for it except the subject, which is flattened and quoted.
 */
async function recordEmailDraft(deps: Deps, connectorId: string, input: In<"email.draft">, provided: ProviderOut<"email.draft">): Promise<Out<"email.draft">> {
  if (typeof provided?.providerDraftId !== "string" || !provided.providerDraftId) {
    throw new Error(`${connectorId} did not return a provider draft id`);
  }
  const threadId = provided.threadId ?? input.threadId;
  const draft = await deps.repos.drafts.create({
    kind: "email",
    connectorId,
    providerDraftId: provided.providerDraftId,
    to: input.to,
    cc: input.cc ?? [],
    subject: input.subject,
    body: input.body,
    ...(threadId ? { threadId } : {}),
    ...(input.client ? { client: input.client } : {}),
    ...(input.followupId ? { followupId: input.followupId } : {}),
  });
  return { draftId: draft.id, providerDraftId: provided.providerDraftId, readback: draft.readback };
}

/** The owner alert for a connection that needs reconnecting. Best effort: never fails the call path. */
async function alertNeedsReauth(deps: Deps, connector: Connector): Promise<void> {
  try {
    await deliverAlert(deps, {
      title: `Reconnect ${connector.displayName}`,
      body: `SideKiqq can't use ${connector.displayName} until you reconnect it from Connections in the dashboard.`,
      priority: "normal",
      data: { kind: "connection_needs_reauth", importance: "HIGH" },
    });
  } catch (err) {
    console.warn("[connections] needs_reauth alert failed", err);
  }
}

/** OAuth refresh failure: the stored refresh token was revoked or expired (Google: `invalid_grant`; others throw ReauthRequiredError). */
export function isInvalidGrant(err: unknown): boolean {
  if (err instanceof ReauthRequiredError) return true;
  const e = err as { message?: unknown; response?: { data?: { error?: unknown } } } | null;
  if (e?.response?.data?.error === "invalid_grant") return true;
  // google-auth-library sometimes rewrites the message to the JSON error body.
  return typeof e?.message === "string" && (e.message === "invalid_grant" || /"error"\s*:\s*"invalid_grant"/.test(e.message));
}

/** Typed helper for the multi-op `email.read` capability. */
export function readEmail<I extends EmailReadIn>(deps: Deps, input: I, ctx: ConnCtx): Promise<EmailReadOutput<I>> {
  return invokeCapability(deps, "email.read", input, ctx) as Promise<EmailReadOutput<I>>;
}
