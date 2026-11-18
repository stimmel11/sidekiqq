import { optional } from "../env";
import { isAllowedPushEndpoint } from "./endpoint";
import type { WebPushSubscription } from "../models";

/**
 * Web Push (VAPID, RFC 8291/8292) to browsers, next to FCM (docs/WEBAPP.md §5).
 * Configured by VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (`mailto:` or an https URL).
 *
 * Only proactive alerts go out this way, and every push carries a visible title/body: there are
 * no silent web pushes (iOS revokes subscriptions that receive them), so the command nudge is never
 * sent to browsers.
 */

export type WebPushOutcome =
  /** Accepted by the push service. */
  | { status: "sent" }
  /** 404/410: the subscription is gone; forget it. */
  | { status: "gone"; code: number }
  /** 429: back off for `retryAfterSeconds`. */
  | { status: "rate_limited"; retryAfterSeconds: number }
  /** Anything else (400/413 payload problems, 5xx, network, timeout). The subscription is kept. */
  | { status: "failed"; code?: number }
  /** Refused locally: the endpoint is not on the allowlist. Nothing was sent. */
  | { status: "blocked" };

export interface WebPushOptions {
  /** Seconds the push service may hold the message for an offline browser. */
  ttlSeconds: number;
  urgency: "high" | "normal";
}

export interface WebPushSender {
  readonly enabled: boolean;
  /** The VAPID public key browsers pass as `applicationServerKey`; null when not configured. */
  readonly publicKey: string | null;
  send(sub: WebPushSubscription, payload: string, opts: WebPushOptions): Promise<WebPushOutcome>;
}

export class NoopWebPushSender implements WebPushSender {
  readonly enabled = false;
  readonly publicKey = null;
  async send(): Promise<WebPushOutcome> {
    return { status: "failed" };
  }
}

export const WEBPUSH_TIMEOUT_MS = 5_000;
export const DEFAULT_RETRY_AFTER_SECONDS = 300;
export const MAX_RETRY_AFTER_SECONDS = 3600;

/** Retry-After as seconds (delta or HTTP date), clamped to [60, 3600]; default 300. */
export function retryAfterSeconds(header: string | undefined, now: number = Date.now()): number {
  if (!header) return DEFAULT_RETRY_AFTER_SECONDS;
  const trimmed = header.trim();
  let secs: number;
  if (/^\d+$/.test(trimmed)) secs = Number(trimmed);
  else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return DEFAULT_RETRY_AFTER_SECONDS;
    secs = Math.ceil((at - now) / 1000);
  }
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(60, secs));
}

/** Map a push service status code to what we do with the subscription. */
export function outcomeForStatus(code: number, headers: Record<string, string | undefined> = {}): WebPushOutcome {
  if (code >= 200 && code < 300) return { status: "sent" };
  if (code === 404 || code === 410) return { status: "gone", code };
  if (code === 429) return { status: "rate_limited", retryAfterSeconds: retryAfterSeconds(headers["retry-after"]) };
  return { status: "failed", code };
}

type WebPushLib = typeof import("web-push");

async function loadWebPush(): Promise<WebPushLib> {
  const mod = (await import("web-push")) as WebPushLib & { default?: WebPushLib };
  return mod.default ?? mod;
}

export class VapidWebPushSender implements WebPushSender {
  readonly enabled = true;
  private lib: Promise<WebPushLib> | null = null;

  constructor(
    readonly publicKey: string,
    private readonly privateKey: string,
    private readonly subject: string,
    private readonly load: () => Promise<WebPushLib> = loadWebPush,
  ) {}

  async send(sub: WebPushSubscription, payload: string, opts: WebPushOptions): Promise<WebPushOutcome> {
    // Checked at register too; checked again here so a record written by older code can't be used.
    if (!isAllowedPushEndpoint(sub.endpoint)) return { status: "blocked" };
    this.lib ??= this.load();
    const webpush = await this.lib;
    try {
      const res = await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, payload, {
        vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey },
        TTL: opts.ttlSeconds,
        urgency: opts.urgency,
        timeout: WEBPUSH_TIMEOUT_MS,
      });
      return outcomeForStatus(res.statusCode, lowerHeaders(res.headers));
    } catch (err) {
      const e = err as { statusCode?: unknown; headers?: unknown };
      if (typeof e?.statusCode === "number") return outcomeForStatus(e.statusCode, lowerHeaders(e.headers));
      console.warn("[webpush] send failed", (err as Error)?.message);
      return { status: "failed" };
    }
  }
}

function lowerHeaders(h: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) out[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : v == null ? undefined : String(v);
  }
  return out;
}

/** `mailto:` address or an https URL, as RFC 8292 asks. */
export function isValidVapidSubject(s: string): boolean {
  if (/^mailto:[^\s@]+@[^\s@]+$/.test(s)) return true;
  try {
    return new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

/** Same shape checks web-push's setVapidDetails makes: a 65-byte uncompressed public key and a 32-byte private key. */
export function isValidVapidKeyPair(pub: string, priv: string): boolean {
  const b64 = /^[A-Za-z0-9_-]+=*$/;
  if (!b64.test(pub) || !b64.test(priv)) return false;
  const p = Buffer.from(pub, "base64url");
  return p.length === 65 && p[0] === 0x04 && Buffer.from(priv, "base64url").length === 32;
}

export function webPushSenderFromEnv(): WebPushSender {
  const pub = optional("VAPID_PUBLIC_KEY");
  const priv = optional("VAPID_PRIVATE_KEY");
  const subject = optional("VAPID_SUBJECT");
  if (!pub || !priv || !subject) return new NoopWebPushSender();
  if (!isValidVapidKeyPair(pub, priv)) {
    console.error("[webpush] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are not a base64url P-256 key pair; Web Push is off");
    return new NoopWebPushSender();
  }
  if (!isValidVapidSubject(subject)) {
    console.error("[webpush] VAPID_SUBJECT must be mailto:<address> or an https URL; Web Push is off");
    return new NoopWebPushSender();
  }
  return new VapidWebPushSender(pub, priv, subject);
}
