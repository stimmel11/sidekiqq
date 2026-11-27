import { config } from "./env";
import { legacyOwnerPrefix } from "./platform/keys";
import { TenantRegistry } from "./platform/tenants";
import { keyRingFromEnv } from "./crypto";
import { UpstashKV, type KV } from "./kv";
import { createRepos, type Repos } from "./repos";
import { GoogleTokenStore } from "./google/auth";
import { GoogleWorkspace } from "./google/workspace";
import { GoogleContacts, googlePeopleApi } from "./google/contacts";
import { GoogleConnector } from "./connectors/google";
import { ConnectionStore } from "./connectors/store";
import { ZoomConnector } from "./connectors/zoom";
import { ZoomAuth, zoomConfigFromEnv, zoomRefreshLock } from "./connectors/zoom/auth";
import { ZoomMeetings } from "./connectors/zoom/meetings";
import { GmailDraftSender, GoogleCalendarInviter } from "./connectors/google/send";
import { buildSenders, type SenderRegistry } from "./connectors/senders";
import type { Connector } from "./connectors/types";
import { llmFromEnv, type LLM } from "./assistant/llm";
import { pushSenderFromEnv, type PushSender } from "./push";
import { webPushSenderFromEnv, type WebPushSender } from "./push/webpush";
import { WebPushStore } from "./push/webpush-store";
import { transcriberFromEnv, type Transcriber } from "./transcribe";
import { speechSynthesizerFromEnv, type SpeechSynthesizer } from "./tts";

/**
 * Dependency container, split per docs/WEBAPP.md §3.1 (slice A1):
 *
 * - `PlatformDeps`: shared, holds no customer data (KV client, clock, model/push/voice clients,
 *   the tenant registry).
 * - `TenantDeps`: everything built from one tenant's key prefix (repos, connections, connectors,
 *   senders, Web Push subscriptions). Built by `tenantDeps(platform, tenant)`.
 *
 * Until principals resolve a tenant (A2), routes still call getDeps(), which is the owner
 * tenant on the legacy prefix: exactly the keys used before the split. Tests call setDeps().
 * Everything that needs a secret is constructed lazily so unrelated routes keep working
 * (and `next build` succeeds) when a given integration isn't configured.
 */
export interface PlatformDeps {
  kv: KV;
  clock: () => Date;
  llm(): LLM;
  push(): PushSender;
  /** Web Push (VAPID) to browsers; disabled when VAPID_* aren't set. */
  webPush(): WebPushSender;
  transcriber(): Transcriber;
  /** Text-to-speech for devices that play audio themselves (Reachy Mini). */
  tts(): SpeechSynthesizer;
  /** Platform tenant records (`g:tenant:*`, `g:owner`, `g:tenants`). */
  tenants: TenantRegistry;
}

/**
 * Which tenant a `TenantDeps` belongs to. `id` is null only for the legacy owner scope that
 * getDeps() builds before the owner tenant record is looked up (A2 resolves it per request).
 */
export interface TenantScope {
  id: string | null;
  prefix: string;
}

export interface TenantDeps {
  tenant: TenantScope;
  repos: Repos;
  /** Encrypted per-connector credentials, status and enabled capabilities (docs/CONNECTORS.md §7). */
  connections: ConnectionStore;
  /** Google's view of `connections`, used by the Google OAuth routes. */
  googleTokens: GoogleTokenStore;
  /**
   * Connectors (Google: Gmail/Calendar/Drive/Contacts; Zoom when configured). Only lib/connectors/invoke.ts may call
   * `Connector.invoke`; everything else goes through `invokeCapability`.
   */
  connectors(): readonly Connector[];
  /** Zoom sign-in and token minting for the Zoom OAuth flow; null when Zoom isn't configured. */
  zoomAuth(): ZoomAuth | null;
  /** SENDER REGISTRY. Must only be used by /api/drafts/[id]/approve (see test/no-send.test.ts). */
  senders(): SenderRegistry;
  /** Browsers' Web Push subscriptions, sealed with TOKEN_ENCRYPTION_KEY. */
  webPushSubs: WebPushStore;
}

/** What routes use today: the platform plus one tenant. */
export type Deps = PlatformDeps & TenantDeps;

let current: Deps | null = null;

export function buildPlatformDeps(kv: KV, clock: () => Date = () => new Date()): PlatformDeps {
  let llm: LLM | null = null;
  let push: PushSender | null = null;
  let webPush: WebPushSender | null = null;
  return {
    kv,
    clock,
    llm: () => (llm ??= llmFromEnv()),
    push: () => (push ??= pushSenderFromEnv()),
    webPush: () => (webPush ??= webPushSenderFromEnv()),
    transcriber: () => transcriberFromEnv(),
    tts: () => speechSynthesizerFromEnv(),
    tenants: new TenantRegistry(kv, clock),
  };
}

/** The owner tenant on its legacy prefix (`REDIS_PREFIX`): the scope every route used before accounts. */
export function legacyOwnerScope(): TenantScope {
  return { id: null, prefix: legacyOwnerPrefix() };
}

/**
 * Builds one tenant's deps from its prefix. Never cache the result across requests once
 * principals carry tenants (A2): a tenant object belongs to one request.
 */
export function tenantDeps(platform: PlatformDeps, tenant: TenantScope): TenantDeps {
  const { kv, clock } = platform;
  const prefix = tenant.prefix;
  if (!prefix) throw new Error("tenant prefix is required");
  const repos = createRepos(kv, {
    prefix,
    clock,
    conversationTtlSeconds: config.conversationTtlSeconds(),
    conversationMaxMessages: config.conversationMaxMessages(),
    alertRetentionDays: config.alertLogDays(),
  });
  const connections = new ConnectionStore(kv, prefix, keyRingFromEnv);
  const googleTokens = new GoogleTokenStore(connections);
  const googleWorkspace = async () => new GoogleWorkspace(await googleTokens.authorizedClient());
  const googleContacts = async () => new GoogleContacts(googlePeopleApi(await googleTokens.authorizedClient()));
  // Zoom is registered only when ZOOM_CLIENT_ID/ZOOM_CLIENT_SECRET are set.
  const zoomCfg = zoomConfigFromEnv(config.appUrl());
  const zoomAuth = zoomCfg ? new ZoomAuth(zoomCfg, connections, fetch, Date.now, zoomRefreshLock(kv, prefix)) : null;
  const zoomMeetings = zoomAuth ? new ZoomMeetings(zoomAuth) : null;
  let connectors: Connector[] | null = null;
  let senders: SenderRegistry | null = null;
  return {
    tenant: { id: tenant.id, prefix },
    repos,
    connections,
    googleTokens,
    connectors: () =>
      (connectors ??= [
        new GoogleConnector(googleWorkspace, googleContacts),
        ...(zoomMeetings ? [new ZoomConnector(async () => zoomMeetings)] : []),
      ]),
    zoomAuth: () => zoomAuth,
    senders: () =>
      (senders ??= buildSenders({
        google: {
          workspace: googleWorkspace,
          mailer: async () => new GmailDraftSender(await googleTokens.authorizedClient()),
          calendar: async () => new GoogleCalendarInviter(await googleTokens.authorizedClient()),
        },
        clock,
      })),
    webPushSubs: new WebPushStore(kv, prefix, keyRingFromEnv),
  };
}

/** Platform + the legacy owner tenant. Same keys and behaviour as before the split. */
export function buildDeps(kv: KV): Deps {
  const platform = buildPlatformDeps(kv);
  return { ...platform, ...tenantDeps(platform, legacyOwnerScope()) };
}

export function getDeps(): Deps {
  current ??= buildDeps(UpstashKV.fromEnv());
  return current;
}

/** Test hook. */
export function setDeps(deps: Deps | null): void {
  current = deps;
}
