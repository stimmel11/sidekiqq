import { google } from "googleapis";
import type { OAuth2Client } from "./auth";

/**
 * THE ONLY CODE THAT SENDS EMAIL.
 *
 * Imported exclusively by src/app/api/drafts/[id]/approve/route.ts (via deps.mailSender).
 * test/no-send.test.ts fails the build if any other module calls a Gmail send method or
 * reaches for the mail sender.
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
