import type { Workspace } from "../google/workspace";
import type { Draft, DraftKind } from "../models";
import { googleEmailExecutor, type MailSender } from "./google/send";

export type { DraftKind };

/**
 * THE SENDER REGISTRY (docs/CONNECTORS.md §6).
 *
 * Every executor that sends, invites or otherwise notifies someone is registered here, keyed by
 * (connectorId, draft kind), and lives in `lib/connectors/<id>/send.ts`. Only lib/deps.ts
 * imports this module and only POST /api/drafts/[id]/approve calls `deps.senders()`, so a
 * confirmed Draft is the only thing that can ever be executed. No `Connector.invoke` reaches
 * these functions.
 */

export interface SendResult {
  messageId?: string;
  threadId?: string;
}

/**
 * Whether a pending draft may be executed right now (docs/CONNECTORS.md §5). Not ok → nothing is
 * sent. `gone`: the provider draft no longer exists (410, marked discarded). `changed`: the
 * provider draft no longer matches what the read-back described (409, marked discarded).
 * `invalid`: the record can't be executed by this sender (422, left as is).
 */
export type DraftCheck = { ok: true } | { ok: false; reason: "gone" | "changed" | "invalid"; message: string };

export interface DraftExecutor {
  check(draft: Draft): Promise<DraftCheck>;
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

  /**
   * `(connectorId, kind)`. Drafts created before slice 3 have neither field; DraftSchema defaults
   * them to ("google", "email") on read. Calendar kinds have no executor registered yet, so they
   * can't be approved until the calendar connector item adds one (and the phone's confirm dialog
   * depends on `kind`).
   */
  static keyFor(draft: Pick<Draft, "connectorId" | "kind">): string {
    return `${draft.connectorId}:${draft.kind}`;
  }

  /** Whether an executor is registered for this draft's (connectorId, kind). */
  has(draft: Pick<Draft, "connectorId" | "kind">): boolean {
    return this.entries.has(SenderRegistry.keyFor(draft));
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
