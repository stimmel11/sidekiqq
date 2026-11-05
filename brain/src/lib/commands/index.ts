import { HttpError } from "../http";
import type { CommandKind, CreateCommandRequest, DeviceCommand, DeviceKind, DeviceRecord } from "../models";

/**
 * Task layer + device routing (slice 1): validation, labels and target resolution for device
 * commands. Commands are hand-offs (`user_finishes` in docs/CONNECTORS.md §4.3): the brain only
 * queues them; the target device shows `label` and the owner taps to act. Nothing here sends a
 * message, places a call or opens anything by itself.
 */

/** How long a queued command stays deliverable. A "call Dana" from an hour ago must not pop up. */
export const COMMAND_TTL_SECONDS = 15 * 60;
/**
 * An "opened" ack may arrive this long after `expiresAt` (the owner tapped just before expiry and
 * the ack was slow). Devices decide whether a command is still live by what GET /api/commands
 * returned, not by their own clock.
 */
export const OPENED_ACK_GRACE_SECONDS = 60;
/** Most pending commands one device can have queued. */
export const MAX_PENDING_PER_DEVICE = 20;

/** Which device kinds can run each command. The first entry is the default target. */
export const COMMAND_TARGETS: Record<CommandKind, readonly DeviceKind[]> = {
  open_url: ["phone"],
  call_contact: ["phone"],
  reachy_wake: ["reachy"],
};

/**
 * `open_url` host allowlist (CONNECTORS.md §2 `device.open_url`): meeting join links and grocery
 * cart pages only. Exact hosts, plus registrable domains whose subdomains are allowed.
 *
 * POST /api/commands serves the owner-device path. From `/api/ask`, the `call_on_phone` tool queues
 * call_contact hand-offs with the number bound by ./call.ts (contacts.lookup in the same request or
 * digits the owner spoke). Connector hand-offs (grocery.checkout, join links) will go through
 * invokeCapability with the §4.4 caller rules and a per-capability allowlist.
 */
export const OPEN_URL_HOSTS: readonly string[] = ["meet.google.com", "www.kroger.com", "www.kingsoopers.com"];
export const OPEN_URL_DOMAINS: readonly string[] = ["zoom.us"];

export class CommandError extends HttpError {
  constructor(message: string, code = "bad_command", status = 400) {
    super(status, message, code);
  }
}

/** https only, no credentials or custom port, host on the allowlist. Returns the normalised href. */
export function validateOpenUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CommandError("url must be an absolute https URL", "bad_url");
  }
  if (u.protocol !== "https:") throw new CommandError("only https links can be opened", "bad_url");
  if (u.username || u.password) throw new CommandError("links with credentials are not allowed", "bad_url");
  if (u.port) throw new CommandError("links with a custom port are not allowed", "bad_url");
  const host = u.hostname.toLowerCase();
  const allowed = OPEN_URL_HOSTS.includes(host) || OPEN_URL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  if (!allowed) throw new CommandError(`links to ${host} can't be opened on a device`, "url_not_allowed");
  return u;
}

/**
 * A number the owner spoke or typed. Digits with optional spaces, dots, dashes and brackets, and an
 * optional leading "+". `*` and `#` are rejected (dialer MMI/USSD codes). 3–15 digits (E.164 max).
 */
export function normalizeNumber(raw: string): string {
  const s = raw.trim();
  if (!/^\+?[0-9 ().-]+$/.test(s)) throw new CommandError("number may only contain digits, spaces, + ( ) . -", "bad_number");
  const digits = s.replace(/\D/g, "");
  if (digits.length < 3 || digits.length > 15) throw new CommandError("number must have 3 to 15 digits", "bad_number");
  return (s.startsWith("+") ? "+" : "") + digits;
}

/**
 * Display names go into a label a device shows. Strip control, zero-width and bidi characters, and
 * also digits, "+" and brackets, so a name can't carry a fake number ("Bank (+1 303 555 0142)")
 * next to the real one. Devices also show `number` on its own line, never only via `label`.
 */
export function cleanName(raw: string): string {
  const s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/[\p{N}+()[\]{}<>]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  // Nothing readable left (e.g. the "name" was a number): no name.
  if (!/\p{L}/u.test(s)) return "";
  return Array.from(s).slice(0, 80).join("").trim();
}

const ACTIVITY_LABEL = {
  chat: "to chat",
  brief: "to read your brief",
  dance: "to dance",
  game: "to play a game",
} as const;

export type CommandFields = Pick<DeviceCommand, "kind" | "label" | "url" | "number" | "name" | "app" | "activity">;

/** Validate a request and build the stored fields. The label is built here, never by a model. */
export function buildCommand(req: CreateCommandRequest): CommandFields {
  switch (req.kind) {
    case "open_url": {
      if (!req.url) throw new CommandError("open_url needs url");
      if (req.number || req.name || req.app || req.activity) throw new CommandError("open_url takes only url");
      const u = validateOpenUrl(req.url);
      return { kind: "open_url", url: u.href, label: `Open ${u.hostname.toLowerCase()} link` };
    }
    case "call_contact": {
      if (!req.number) throw new CommandError("call_contact needs number");
      if (req.url || req.activity) throw new CommandError("call_contact takes number, name and app only");
      const number = normalizeNumber(req.number);
      const name = req.name ? cleanName(req.name) : "";
      const app = req.app ?? "phone";
      if (app === "whatsapp" && !number.startsWith("+")) {
        throw new CommandError("WhatsApp needs an international number starting with +", "bad_number");
      }
      const who = name ? `${name} (${number})` : number;
      return {
        kind: "call_contact",
        number,
        ...(name ? { name } : {}),
        app,
        label: `Call ${who}${app === "whatsapp" ? " on WhatsApp" : ""}`,
      };
    }
    case "reachy_wake": {
      if (req.url || req.number || req.name || req.app) throw new CommandError("reachy_wake takes only activity");
      const activity = req.activity ?? "chat";
      return { kind: "reachy_wake", activity, label: `Wake Reachy ${ACTIVITY_LABEL[activity]}` };
    }
  }
}

/**
 * Pick the device a command is queued for.
 * - `deviceId`: that device, if paired, not revoked and of a kind that can run the command.
 * - `device` (a kind) or nothing: the most recently seen paired device of that kind (default: the
 *   command's first allowed kind).
 */
export function resolveTarget(
  kind: CommandKind,
  target: { deviceId?: string | undefined; device?: DeviceKind | undefined } | undefined,
  devices: DeviceRecord[],
): DeviceRecord {
  const allowed = COMMAND_TARGETS[kind];
  const live = devices.filter((d) => !d.revoked);
  if (target?.deviceId) {
    const d = live.find((x) => x.id === target.deviceId);
    if (!d) throw new CommandError("no such device", "unknown_device", 404);
    if (!allowed.includes(d.kind)) throw new CommandError(`a ${d.kind} can't run ${kind}`, "wrong_target", 409);
    return d;
  }
  const want = target?.device ?? allowed[0]!;
  if (!allowed.includes(want)) throw new CommandError(`a ${want} can't run ${kind}`, "wrong_target", 409);
  const seen = (d: DeviceRecord) => Date.parse(d.lastSeenAt ?? d.createdAt);
  const best = live.filter((d) => d.kind === want).sort((a, b) => seen(b) - seen(a))[0];
  if (!best) throw new CommandError(`no paired ${want} to run this on`, "no_target_device", 409);
  return best;
}
