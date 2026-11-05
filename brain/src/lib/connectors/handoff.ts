import { z } from "zod";
import type { Deps } from "../deps";
import type { DeviceKind } from "../models";
import { truncate } from "../util";
import { buildCommand, CommandError, resolveTarget, validateOpenUrl } from "../commands";
import { nudgeCommandTarget } from "../commands/nudge";
import { isCapabilityId, OWNER_INITIATED, POLICY, type CapabilityId } from "./capabilities";
import { CapabilityDeniedError, type ConnCtx } from "./types";

/**
 * Task layer slice 4b: the `user_finishes` path (docs/CONNECTORS.md §4.3).
 *
 * `invokeCapability` never runs a `user_finishes` capability. This is where they go instead: the
 * brain queues a tap-to-act hand-off on the owner's phone (device command queue) and nudges it.
 * Nothing is opened here, and the brain never learns or assumes that the owner finished.
 *
 * Rules, all enforced here (not by the caller):
 *  1. Only capabilities in HANDOFF_CAPABILITIES. `device.call` keeps its own path (the
 *     `call_on_phone` tool, lib/commands/call.ts); `grocery.checkout` waits for the Kroger connector.
 *  2. Owner-initiated callers only (`ask`, `task`, `dashboard`); `cron` and `brief` fail closed.
 *  3. The asking device (`origin`) must be the authenticated device of the owner request.
 *  4. The URL must pass the command allowlist (https, no credentials/port) AND this capability's
 *     narrower host rule, AND be exactly one of `allowedUrls`: links the brain itself created in
 *     this request (e.g. the Zoom join link from `video.create_room`). A link read in an email,
 *     file or calendar event can never reach the phone through this path.
 *  5. Every attempt that passes rule 1, refusals included, writes one audit row. The summary holds
 *     the link's host only, never the full URL (Zoom links carry the passcode).
 */

export const HANDOFF_CAPABILITIES = ["device.open_url"] as const;
export type HandoffCapability = (typeof HANDOFF_CAPABILITIES)[number];

/** Meeting join links only (CONNECTORS.md §2 `device.open_url`). Cart pages belong to `grocery.checkout`. */
const MEETING_HOSTS: readonly string[] = ["meet.google.com"];
const MEETING_DOMAINS: readonly string[] = ["zoom.us"];

export const HANDOFF_HOST_RULES: Record<HandoffCapability, (host: string) => boolean> = {
  "device.open_url": (h) => MEETING_HOSTS.includes(h) || MEETING_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`)),
};

const HandoffInput = z.object({ url: z.string().trim().min(1).max(2048) }).strict();

export interface HandoffCtx extends ConnCtx {
  /** The authenticated device that made the owner request (becomes the command's `from`). */
  origin: { deviceId: string; deviceKind: DeviceKind };
  /** Links the brain created in this request. The hand-off URL must be exactly one of them. */
  allowedUrls: ReadonlySet<string>;
}

export interface HandoffResult {
  queued: true;
  commandId: string;
  label: string;
  url: string;
  expiresAt: string;
}

function isHandoffCapability(cap: string): cap is HandoffCapability {
  return (HANDOFF_CAPABILITIES as readonly string[]).includes(cap);
}

/** Normalised href, or null for anything that isn't an absolute URL. */
function href(raw: string): string | null {
  try {
    return new URL(raw).href;
  } catch {
    return null;
  }
}

/** Host for the audit summary: parsed, lower-case, only hostname characters, short. */
function auditHost(raw: string): string {
  try {
    return truncate(new URL(raw).hostname.toLowerCase().replace(/[^a-z0-9.-]/g, ""), 80) || "link";
  } catch {
    return "link";
  }
}

export async function handoffCapability(deps: Deps, cap: string, input: unknown, ctx: HandoffCtx): Promise<HandoffResult> {
  if (!isCapabilityId(cap)) throw new CapabilityDeniedError(cap, "not a capability");
  if (POLICY[cap as CapabilityId] !== "user_finishes") throw new CapabilityDeniedError(cap, "only user_finishes capabilities are handed off");
  if (!isHandoffCapability(cap)) {
    throw new CapabilityDeniedError(
      cap,
      cap === "device.call" ? "calls are handed off by the call_on_phone tool" : "this hand-off is not available yet",
    );
  }

  const parsed = HandoffInput.safeParse(input);
  const rawUrl = parsed.success ? parsed.data.url : "";
  const audit = (ok: boolean, error?: string) =>
    deps.repos.audit
      .add({
        connector: "device",
        capability: cap,
        tier: "user_finishes",
        caller: ctx.caller,
        ...((ctx.origin?.deviceKind ?? ctx.device) ? { device: ctx.origin?.deviceKind ?? ctx.device } : {}),
        summary: `hand-off to phone: ${auditHost(rawUrl)}`,
        ok,
        ...(error ? { error: truncate(error, 300) } : {}),
      })
      .catch((err: unknown) => console.warn("[audit] write failed", err));

  const refuse = async (err: Error): Promise<never> => {
    await audit(false, err instanceof CommandError ? `${err.code ?? "refused"}: ${err.message}` : err.message);
    throw err;
  };

  if (!OWNER_INITIATED.includes(ctx.caller)) return refuse(new CapabilityDeniedError(cap, `not allowed for background caller "${ctx.caller}"`));
  if (!ctx.origin?.deviceId) return refuse(new CapabilityDeniedError(cap, "hand-offs need the owner request's device"));
  if (!parsed.success) return refuse(new CapabilityDeniedError(cap, "invalid input: url must be a string"));

  let row;
  let target;
  try {
    const u = validateOpenUrl(rawUrl);
    if (!HANDOFF_HOST_RULES[cap](u.hostname.toLowerCase())) {
      throw new CommandError(`links to ${u.hostname.toLowerCase()} can't be handed off as ${cap}`, "url_not_allowed");
    }
    const allowed = new Set([...ctx.allowedUrls].map(href).filter((h): h is string => h !== null));
    if (!allowed.has(u.href)) {
      throw new CommandError("only a link SideKiqq created in this request can be opened on the phone", "link_not_created");
    }
    const fields = buildCommand({ kind: "open_url", url: u.href });
    target = resolveTarget("open_url", undefined, await deps.repos.devices.list());
    row = await deps.repos.commands.enqueue(fields, { id: ctx.origin.deviceId, kind: ctx.origin.deviceKind }, target.id);
  } catch (err) {
    return refuse(err as Error);
  }
  await audit(true);
  // Same silent, id-only FCM nudge as POST /api/commands (best effort, never throws).
  await nudgeCommandTarget(deps, target, row.id);
  return { queued: true, commandId: row.id, label: row.label, url: row.url!, expiresAt: row.expiresAt };
}
