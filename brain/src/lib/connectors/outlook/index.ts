import type { EmailMessage, EmailSummary } from "../../google/workspace";
import type { CapabilityId, ImplementedCapability, In, ProviderOut } from "../capabilities";
import type { Connector } from "../types";
import { OUTLOOK_CONNECTOR_ID, OUTLOOK_MAIL_READ_SCOPE } from "./auth";

/**
 * The built-in Outlook / Microsoft 365 connector (docs/CONNECTORS.md §2, §10 step 7). One capability
 * so far: `email.read`, through the read-only Graph module `lib/microsoft/mail.ts` (GET only; Graph's
 * send/reply endpoints are banned outside a sender by test/no-send.test.ts). No `email.draft` and no
 * sender yet (Outlook slice 3), so nothing here can create, send, move or delete mail.
 *
 * First-party (Microsoft), so `invokeCapability` doesn't log its arguments in the audit log.
 */

export const OUTLOOK_CAPABILITIES = ["email.read"] as const satisfies readonly CapabilityId[];

/** What the connector needs from `OutlookMail`. Read-only. */
export interface OutlookMailReader {
  search(query: string, max: number): Promise<EmailSummary[]>;
  listRecentIds(since: Date, max: number): Promise<{ id: string; threadId: string }[]>;
  getMessage(id: string): Promise<EmailMessage>;
  getThread(conversationId: string): Promise<EmailMessage[]>;
  account(): Promise<{ email?: string }>;
}

export class OutlookConnector implements Connector {
  readonly id = OUTLOOK_CONNECTOR_ID;
  readonly displayName = "Outlook (Microsoft 365)";
  readonly firstParty = true;
  readonly capabilities: readonly CapabilityId[] = OUTLOOK_CAPABILITIES;

  /** The token source behind `mail` throws OutlookNotConnectedError when Outlook isn't connected. */
  constructor(private readonly mail: () => Promise<OutlookMailReader>) {}

  scopesFor(caps: readonly CapabilityId[]): string[] {
    return caps.includes("email.read") ? [OUTLOOK_MAIL_READ_SCOPE] : [];
  }

  async invoke<C extends ImplementedCapability>(cap: C, input: In<C>): Promise<ProviderOut<C>> {
    if (cap !== "email.read") throw new Error(`outlook connector does not implement ${String(cap)}`);
    const i = input as In<"email.read">;
    const mail = await this.mail();
    let out: ProviderOut<"email.read">;
    if (i.op === "search") out = await mail.search(i.query, i.max);
    else if (i.op === "list_ids") out = await mail.listRecentIds(new Date(i.since), i.max);
    else if (i.op === "thread") out = await mail.getThread(i.threadId);
    else if (i.op === "message") out = await mail.getMessage(i.id);
    else out = await mail.account();
    return out as ProviderOut<C>;
  }
}
