import type { Deps } from "../deps";
import { AlertKindSchema, ImportanceSchema } from "../models";
import type { PushMessage } from "./index";
import type { WebPushOutcome } from "./webpush";

/**
 * Proactive alerts to browsers over Web Push (docs/WEBAPP.md §5), called by `deliverAlert`.
 *
 * The payload is the alert's title, body, kind, importance and ids, and nothing else: never a
 * draft body, recipient list, URL or anything the service worker could act on. The worker picks
 * where a tap goes from a fixed list of same-origin paths by `kind`; it never reads a URL from
 * the payload, and notifications have no actions, so nothing can be approved or sent from one.
 */

export const WEB_PUSH_TTL_SECONDS = 24 * 60 * 60;
export const WEB_PUSH_TITLE_MAX = 120;
export const WEB_PUSH_BODY_MAX = 600;
/** Ids are opaque, short tokens; anything else is dropped. */
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface WebPushPayload {
  title: string;
  body: string;
  kind?: string;
  importance?: string;
  messageId?: string;
  threadId?: string;
  commitmentId?: string;
}

function clip(s: string, max: number): string {
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function buildWebPushPayload(msg: PushMessage): WebPushPayload {
  const data = msg.data ?? {};
  const out: WebPushPayload = { title: clip(msg.title, WEB_PUSH_TITLE_MAX) || "SideKiqq", body: clip(msg.body, WEB_PUSH_BODY_MAX) };
  const kind = AlertKindSchema.safeParse(data.kind);
  if (kind.success) out.kind = kind.data;
  const importance = ImportanceSchema.safeParse(data.importance);
  if (importance.success) out.importance = importance.data;
  for (const k of ["messageId", "threadId", "commitmentId"] as const) {
    const v = data[k];
    if (typeof v === "string" && ID.test(v)) out[k] = v;
  }
  return out;
}

/** CRITICAL alerts go out with `Urgency: high`; everything else `normal`. */
export function webPushUrgency(msg: PushMessage): "high" | "normal" {
  return msg.data?.importance === "CRITICAL" ? "high" : "normal";
}

/** Whole-send cap per browser (web-push's own timeout is a socket idle timeout), so FCM isn't held up. */
export const WEB_PUSH_TOTAL_TIMEOUT_MS = 6_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | { status: "failed" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<{ status: "failed" }>((resolve) => (timer = setTimeout(() => resolve({ status: "failed" }), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface WebPushDelivery {
  sent: number;
  attempted: number;
}

/**
 * Sends the alert to every non-revoked `web` device with a subscription. Never throws: FCM and the
 * alert log must not depend on browsers. 404/410 clear that subscription; 429 backs that endpoint
 * off for Retry-After; 400/413/5xx keep it (a payload problem must not wipe subscriptions).
 */
export async function deliverWebPush(deps: Deps, msg: PushMessage): Promise<WebPushDelivery> {
  const result: WebPushDelivery = { sent: 0, attempted: 0 };
  try {
    const sender = deps.webPush();
    if (!sender.enabled) return result;
    const devices = (await deps.repos.devices.list()).filter((d) => d.kind === "web" && !d.revoked);
    if (!devices.length) return result;
    const payload = JSON.stringify(buildWebPushPayload(msg));
    const opts = { ttlSeconds: WEB_PUSH_TTL_SECONDS, urgency: webPushUrgency(msg) };
    await Promise.all(
      devices.map(async (d) => {
        try {
          const sub = await deps.webPushSubs.get(d.id);
          if (!sub) return;
          if (await deps.webPushSubs.backingOff(sub.endpoint)) return;
          result.attempted++;
          const outcome: WebPushOutcome = await withTimeout(sender.send(sub, payload, opts), WEB_PUSH_TOTAL_TIMEOUT_MS);
          switch (outcome.status) {
            case "sent":
              result.sent++;
              break;
            case "gone":
            case "blocked":
              await deps.webPushSubs.clearIfEndpoint(d.id, sub.endpoint);
              break;
            case "rate_limited":
              await deps.webPushSubs.backOff(sub.endpoint, outcome.retryAfterSeconds);
              break;
            case "failed":
              console.warn(`[webpush] alert to ${d.id} failed${outcome.code ? ` (${outcome.code})` : ""}; subscription kept`);
              break;
          }
        } catch (err) {
          console.warn(`[webpush] alert to ${d.id} failed`, (err as Error)?.message);
        }
      }),
    );
  } catch (err) {
    console.error("[webpush] delivery failed", (err as Error)?.message);
  }
  return result;
}
