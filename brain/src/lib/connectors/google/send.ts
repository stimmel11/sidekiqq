import { google } from "googleapis";
import type { OAuth2Client } from "../../google/auth";
import type { Workspace } from "../../google/workspace";
import type { Draft } from "../../models";
import type { DraftExecutor } from "../senders";

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
    // The owner may have deleted or sent the draft in Gmail since it was created.
    stillValid: async (d: Draft) => d.kind === "email" && !!d.providerDraftId && (await workspace()).draftExists(d.providerDraftId),
    execute: async (d: Draft) => (await mailer()).sendDraft(gmailDraftId(d)),
  };
}
