import type { Deps } from "../deps";
import { AlertKindSchema, ImportanceSchema } from "../models";
import type { PushMessage } from "./index";

/**
 * The single place a proactive alert is delivered. It is written to the alert log first (so
 * polling devices such as Reachy Mini get exactly the same title/body/data as the push), then
 * sent over FCM to every device with a push token.
 *
 * Returns 1 if the alert reached at least one channel (logged counts), else 0.
 */
export async function deliverAlert(deps: Deps, msg: PushMessage): Promise<number> {
  const data = msg.data ?? {};
  let logged = false;
  const kind = AlertKindSchema.safeParse(data.kind);
  if (kind.success) {
    const importance = ImportanceSchema.safeParse(data.importance);
    try {
      await deps.repos.alerts.add({
        title: msg.title,
        body: msg.body,
        kind: kind.data,
        priority: msg.priority ?? "normal",
        ...(importance.success ? { importance: importance.data } : {}),
        ...(data.client ? { client: data.client } : {}),
        ...(data.messageId ? { messageId: data.messageId } : {}),
        ...(data.threadId ? { threadId: data.threadId } : {}),
        ...(data.commitmentId ? { commitmentId: data.commitmentId } : {}),
      });
      logged = true;
    } catch (err) {
      console.error("[alerts] failed to log alert", err);
    }
  } else {
    console.warn(`[alerts] not logging alert with unknown kind "${data.kind}"`);
  }

  const push = deps.push();
  const tokens = await deps.repos.devices.pushTokens();
  if (!tokens.length) return logged ? 1 : 0;
  const res = await push.send(tokens, msg);
  for (const t of res.invalidTokens) await deps.repos.devices.clearFcmToken(t);
  return logged || res.sent > 0 || !push.enabled ? 1 : 0;
}
