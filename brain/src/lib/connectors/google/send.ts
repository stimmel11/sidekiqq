import { google } from "googleapis";
import type { OAuth2Client } from "../../google/auth";
import { addressesIn } from "../../address";
import type { DraftEnvelope, Workspace } from "../../google/workspace";
import type { Draft } from "../../models";
import type { DraftCheck, DraftExecutor } from "../senders";

/**
 * THE ONLY CODE THAT SENDS GMAIL.
 *
 * Registered in the sender registry (../senders.ts) as ("google", "email"). Only lib/deps.ts
 * imports the registry, and only POST /api/drafts/[id]/approve calls deps.senders().
 * test/no-send.test.ts fails the build if any other module calls a Gmail send method.
 */
export interface MailSender {
  /** Sends an existing Gmail draft. Returns the sent message id. */
  sendDraft(gmailDraftId: string): Promise<{ messageId?: string; threadId?: string }>;
}

export class GmailDraftSender implements MailSender {
  constructor(private readonly auth: OAuth2Client) {}

  async sendDraft(gmailDraftId: string) {
    const gmail = google.gmail({ version: "v1", auth: this.auth });
    const res = await gmail.users.drafts.send({ userId: "me", requestBody: { id: gmailDraftId } });
    return {
      ...(res.data.id ? { messageId: res.data.id } : {}),
      ...(res.data.threadId ? { threadId: res.data.threadId } : {}),
    };
  }
}

/** Sender-registry entry for ("google", "email"). */
export function googleEmailExecutor(workspace: () => Promise<Workspace>, mailer: () => Promise<MailSender>): DraftExecutor {
  const gmailDraftId = (d: Draft): string => {
    if (d.kind !== "email" || !d.providerDraftId) throw new Error("Not a Gmail email draft");
    return d.providerDraftId;
  };
  return {
    check: async (d: Draft): Promise<DraftCheck> => {
      if (d.kind !== "email" || !d.providerDraftId) {
        return { ok: false, reason: "invalid", message: "This draft has no Gmail draft attached, so it can't be sent from here" };
      }
      // The owner may have deleted, sent or edited the draft in Gmail since it was created.
      const env = await (await workspace()).getDraftEnvelope(d.providerDraftId);
      if (!env) return { ok: false, reason: "gone", message: "Draft no longer exists in Gmail" };
      if (!envelopeMatches(d, env)) {
        return { ok: false, reason: "changed", message: "The draft was changed in Gmail since it was read back, so it was not sent. Review it in Gmail" };
      }
      return { ok: true };
    },
    execute: async (d: Draft) => (await mailer()).sendDraft(gmailDraftId(d)),
  };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const addrSet = (values: readonly string[]) => [...new Set(values.flatMap(addressesIn))].sort();
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The Gmail draft still says what the read-back said: the same sorted To and Cc addresses, no
 * Bcc, and the same subject (whitespace-normalised). Anything else → refuse.
 */
export function envelopeMatches(d: Pick<Draft, "to" | "cc" | "subject">, env: DraftEnvelope): boolean {
  return (
    same(addrSet(d.to), addrSet([env.to])) &&
    same(addrSet(d.cc), addrSet([env.cc])) &&
    addrSet([env.bcc]).length === 0 &&
    norm(d.subject) === norm(env.subject)
  );
}
