import type { Workspace } from "../google/workspace";
import type { Draft } from "../models";
import { googleEmailExecutor, type MailSender } from "./google/send";

/**
 * THE SENDER REGISTRY (docs/CONNECTORS.md §6).
 *
 * Every executor that sends, invites or otherwise notifies someone is registered here, keyed by
 * (connectorId, draft kind), and lives in `lib/connectors/<id>/send.ts`. Only lib/deps.ts
 * imports this module and only POST /api/drafts/[id]/approve calls `deps.senders()`, so a
 * confirmed Draft is the only thing that can ever be executed. No `Connector.invoke` reaches
 * these functions.
 */

export type DraftKind = "email";

export interface SendResult {
  messageId?: string;
  threadId?: string;
}

export interface DraftExecutor {
  /** False → the approve route marks the draft discarded and answers 410. */
  stillValid(draft: Draft): Promise<boolean>;
  execute(draft: Draft): Promise<SendResult>;
}

export class UnknownSenderError extends Error {
  constructor(key: string) {
    super(`No sender is registered for ${key}`);
    this.name = "UnknownSenderError";
  }
}

export class SenderRegistry {
  private readonly entries: ReadonlyMap<string, DraftExecutor>;

  constructor(entries: Record<string, DraftExecutor>) {
    this.entries = new Map(Object.entries(entries));
  }

  /** Drafts created before the framework have no kind/connector: they are Gmail emails. */
  static keyFor(_draft: Draft): string {
    return "google:email";
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  for(draft: Draft): DraftExecutor {
    const key = SenderRegistry.keyFor(draft);
    const entry = this.entries.get(key);
    if (!entry) throw new UnknownSenderError(key);
    return entry;
  }
}

export interface SenderFactories {
  google: { workspace: () => Promise<Workspace>; mailer: () => Promise<MailSender> };
}

export function buildSenders(f: SenderFactories): SenderRegistry {
  return new SenderRegistry({
    "google:email": googleEmailExecutor(f.google.workspace, f.google.mailer),
  });
}
