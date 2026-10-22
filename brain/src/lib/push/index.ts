import { optional } from "../env";

export interface PushMessage {
  title: string;
  body: string;
  /** String-only key/values delivered to the app (FCM data payload). */
  data?: Record<string, string>;
  /** "high" for CRITICAL alerts so Android wakes the watch/phone. */
  priority?: "high" | "normal";
}

export interface PushResult {
  sent: number;
  failed: number;
  /** Tokens FCM reports as permanently invalid; callers should forget them. */
  invalidTokens: string[];
}

export interface PushSender {
  readonly enabled: boolean;
  send(tokens: string[], msg: PushMessage): Promise<PushResult>;
}

export class NoopPushSender implements PushSender {
  readonly enabled = false;
  async send(tokens: string[], msg: PushMessage): Promise<PushResult> {
    console.info(`[push] FCM not configured; would send "${msg.title}" to ${tokens.length} device(s)`);
    return { sent: 0, failed: 0, invalidTokens: [] };
  }
}

const INVALID_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/** Parse FIREBASE_SERVICE_ACCOUNT_JSON given either as raw JSON or base64-encoded JSON. */
export function parseServiceAccount(raw: string): { projectId: string; clientEmail: string; privateKey: string } {
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const json = JSON.parse(text) as { project_id?: string; client_email?: string; private_key?: string };
  if (!json.project_id || !json.client_email || !json.private_key) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing project_id, client_email or private_key");
  }
  return { projectId: json.project_id, clientEmail: json.client_email, privateKey: json.private_key.replace(/\\n/g, "\n") };
}

export class FcmPushSender implements PushSender {
  readonly enabled = true;
  private messagingPromise: Promise<import("firebase-admin/messaging").Messaging> | null = null;

  constructor(private readonly serviceAccountRaw: string) {}

  private messaging() {
    this.messagingPromise ??= (async () => {
      const { initializeApp, getApps, cert } = await import("firebase-admin/app");
      const { getMessaging } = await import("firebase-admin/messaging");
      const sa = parseServiceAccount(this.serviceAccountRaw);
      const app = getApps().find((a) => a.name === "sidekiqq") ?? initializeApp({ credential: cert(sa), projectId: sa.projectId }, "sidekiqq");
      return getMessaging(app);
    })();
    return this.messagingPromise;
  }

  async send(tokens: string[], msg: PushMessage): Promise<PushResult> {
    const unique = [...new Set(tokens)].filter(Boolean);
    if (!unique.length) return { sent: 0, failed: 0, invalidTokens: [] };
    const messaging = await this.messaging();
    const res = await messaging.sendEachForMulticast({
      tokens: unique,
      notification: { title: msg.title, body: msg.body },
      data: { title: msg.title, body: msg.body, ...(msg.data ?? {}) },
      android: { priority: msg.priority === "high" ? "high" : "normal", notification: { channelId: "sidekiqq_alerts" } },
    });
    const invalidTokens: string[] = [];
    res.responses.forEach((r, i) => {
      if (!r.success && r.error && INVALID_TOKEN_CODES.has(r.error.code)) invalidTokens.push(unique[i] as string);
    });
    return { sent: res.successCount, failed: res.failureCount, invalidTokens };
  }
}

export function pushSenderFromEnv(): PushSender {
  const sa = optional("FIREBASE_SERVICE_ACCOUNT_JSON");
  return sa ? new FcmPushSender(sa) : new NoopPushSender();
}
