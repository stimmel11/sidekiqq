import type { Deps } from "../deps";
import type { DeviceRecord } from "../models";

/**
 * Task layer slice 4a: after a command is queued, send its target device a silent FCM nudge so it
 * polls GET /api/commands now instead of on its next 30 s tick.
 *
 * The nudge is data-only and carries NO title, body, label, number or URL: just
 * `{ kind: "command", commandId }`. The command itself is only ever read from the authenticated
 * GET /api/commands, so a leaked or replayed push shows nothing and can't open anything, and a
 * client that doesn't know `kind: "command"` has no title/body to turn into a notification.
 * It goes only to the target device's own token (never to every device, unlike alerts) and is
 * never written to the alert log.
 *
 * Best effort: polling is still the delivery guarantee, so this never throws.
 */
export const NUDGE_TIMEOUT_MS = 3_000;

export type NudgeResult = "sent" | "no_token" | "push_disabled" | "failed";

export async function nudgeCommandTarget(deps: Deps, target: DeviceRecord, commandId: string): Promise<NudgeResult> {
  if (target.revoked || !target.fcmToken) return "no_token";
  const push = deps.push();
  if (!push.enabled) return "push_disabled";
  const token = target.fcmToken;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      push.sendData([token], { kind: "command", commandId }, "high"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("FCM nudge timed out")), NUDGE_TIMEOUT_MS);
      }),
    ]);
    if (res.invalidTokens.includes(token)) {
      await deps.repos.devices.clearFcmToken(token).catch(() => undefined);
      return "failed";
    }
    return res.sent > 0 ? "sent" : "failed";
  } catch (err) {
    console.warn("[commands] nudge failed; the device will pick the command up on its next poll", err);
    return "failed";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
