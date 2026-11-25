import { config } from "./env";
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
import { invokeCapability } from "./connectors/invoke";
import type { Connector } from "./connectors/types";
import { llmFromEnv, type LLM } from "./assistant/llm";
import { pushSenderFromEnv, type PushSender } from "./push";
import { webPushSenderFromEnv, type WebPushSender } from "./push/webpush";
import { WebPushStore } from "./push/webpush-store";
import { transcriberFromEnv, type Transcriber } from "./transcribe";
import { speechSynthesizerFromEnv, type SpeechSynthesizer } from "./tts";

/**
 * Dependency container. Routes call getDeps(); tests call setDeps() with fakes.
 * Everything that needs a secret is constructed lazily so unrelated routes keep working
 * (and `next build` succeeds) when a given integration isn't configured.
 */
export interface Deps {
  kv: KV;
  repos: Repos;
  clock: () => Date;
  llm(): LLM;
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
  push(): PushSender;
  /** Web Push (VAPID) to browsers; disabled when VAPID_* aren't set. */
  webPush(): WebPushSender;
  /** Browsers' Web Push subscriptions, sealed with TOKEN_ENCRYPTION_KEY. */
  webPushSubs: WebPushStore;
  transcriber(): Transcriber;
  /** Text-to-speech for devices that play audio themselves (Reachy Mini). */
  tts(): SpeechSynthesizer;
}

let current: Deps | null = null;

export function buildDeps(kv: KV): Deps {
  const prefix = config.redisPrefix();
  const clock = () => new Date();
  const repos = createRepos(kv, {
    prefix,
    clock,
    conversationTtlSeconds: config.conversationTtlSeconds(),
    conversationMaxMessages: config.conversationMaxMessages(),
    alertRetentionDays: config.alertLogDays(),
  });
  const connections = new ConnectionStore(kv, prefix, keyRingFromEnv);
  const googleTokens = new GoogleTokenStore(connections);
  let llm: LLM | null = null;
  let push: PushSender | null = null;
  let webPush: WebPushSender | null = null;
  const googleWorkspace = async () => new GoogleWorkspace(await googleTokens.authorizedClient());
  const googleContacts = async () => new GoogleContacts(googlePeopleApi(await googleTokens.authorizedClient()));
  // Zoom is registered only when ZOOM_CLIENT_ID/ZOOM_CLIENT_SECRET are set.
  const zoomCfg = zoomConfigFromEnv(config.appUrl());
  const zoomAuth = zoomCfg ? new ZoomAuth(zoomCfg, connections, fetch, Date.now, zoomRefreshLock(kv, prefix)) : null;
  const zoomMeetings = zoomAuth ? new ZoomMeetings(zoomAuth) : null;
  let connectors: Connector[] | null = null;
  let senders: SenderRegistry | null = null;
  const deps: Deps = {
    kv,
    repos,
    clock,
    llm: () => (llm ??= llmFromEnv()),
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
        // The Zoom room inside an approved invite goes through invokeCapability like any other
        // room (fixed no-invite body, connection checks, audit). Caller "task": the owner just
        // approved this draft on a device.
        videoRooms: {
          create: (input) => invokeCapability(deps, "video.create_room", input, { caller: "task" }),
          save: (draftId, room) => repos.drafts.setVideoRoom(draftId, room),
        },
      })),
    push: () => (push ??= pushSenderFromEnv()),
    webPush: () => (webPush ??= webPushSenderFromEnv()),
    webPushSubs: new WebPushStore(kv, prefix, keyRingFromEnv),
    transcriber: () => transcriberFromEnv(),
    tts: () => speechSynthesizerFromEnv(),
  };
  return deps;
}

export function getDeps(): Deps {
  current ??= buildDeps(UpstashKV.fromEnv());
  return current;
}

/** Test hook. */
export function setDeps(deps: Deps | null): void {
  current = deps;
}
