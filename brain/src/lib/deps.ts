import { config } from "./env";
import { keyRingFromEnv } from "./crypto";
import { UpstashKV, type KV } from "./kv";
import { createRepos, type Repos } from "./repos";
import { GoogleTokenStore } from "./google/auth";
import { GoogleWorkspace } from "./google/workspace";
import { GoogleConnector } from "./connectors/google";
import { ConnectionStore } from "./connectors/store";
import { GmailDraftSender } from "./connectors/google/send";
import { buildSenders, type SenderRegistry } from "./connectors/senders";
import type { Connector } from "./connectors/types";
import { llmFromEnv, type LLM } from "./assistant/llm";
import { pushSenderFromEnv, type PushSender } from "./push";
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
   * Connectors (Gmail/Calendar/Drive today). Only lib/connectors/invoke.ts may call
   * `Connector.invoke`; everything else goes through `invokeCapability`.
   */
  connectors(): readonly Connector[];
  /** SENDER REGISTRY. Must only be used by /api/drafts/[id]/approve (see test/no-send.test.ts). */
  senders(): SenderRegistry;
  push(): PushSender;
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
  const googleWorkspace = async () => new GoogleWorkspace(await googleTokens.authorizedClient());
  let connectors: Connector[] | null = null;
  let senders: SenderRegistry | null = null;
  return {
    kv,
    repos,
    clock,
    llm: () => (llm ??= llmFromEnv()),
    connections,
    googleTokens,
    connectors: () => (connectors ??= [new GoogleConnector(googleWorkspace)]),
    senders: () =>
      (senders ??= buildSenders({
        google: { workspace: googleWorkspace, mailer: async () => new GmailDraftSender(await googleTokens.authorizedClient()) },
      })),
    push: () => (push ??= pushSenderFromEnv()),
    transcriber: () => transcriberFromEnv(),
    tts: () => speechSynthesizerFromEnv(),
  };
}

export function getDeps(): Deps {
  current ??= buildDeps(UpstashKV.fromEnv());
  return current;
}

/** Test hook. */
export function setDeps(deps: Deps | null): void {
  current = deps;
}
