import type { ContactLookup, ContactQuery } from "../../google/contacts";
import type { Workspace } from "../../google/workspace";
import type { CapabilityId, ImplementedCapability, In, Out } from "../capabilities";
import type { Connector } from "../types";

/**
 * The built-in Google connector: Gmail, Calendar, Drive and Contacts (docs/CONNECTORS.md §8 step 1).
 * A thin wrapper over `Workspace`, so behaviour is unchanged. It has NO send path: sending a
 * Gmail draft lives only in ./send.ts, registered in the sender registry.
 */

const SCOPES: Partial<Record<CapabilityId, string[]>> = {
  "email.read": ["https://www.googleapis.com/auth/gmail.readonly"],
  "email.draft": ["https://www.googleapis.com/auth/gmail.compose"],
  "calendar.read": ["https://www.googleapis.com/auth/calendar.readonly"],
  "files.read": ["https://www.googleapis.com/auth/drive.readonly"],
  "contacts.lookup": ["https://www.googleapis.com/auth/contacts.readonly", "https://www.googleapis.com/auth/contacts.other.readonly"],
};

export const GOOGLE_CAPABILITIES = ["email.read", "email.draft", "calendar.read", "files.read", "contacts.lookup"] as const satisfies readonly CapabilityId[];

/** What the connector needs from lib/google/contacts.ts (`GoogleContacts`). Read-only. */
export interface ContactsLookup {
  lookup(q: ContactQuery): Promise<ContactLookup>;
}

export class GoogleConnector implements Connector {
  readonly id = "google";
  readonly displayName = "Google (Gmail, Calendar, Drive, Contacts)";
  readonly firstParty = true;
  readonly capabilities: readonly CapabilityId[];

  /**
   * Both factories throw GoogleNotConnectedError when Google isn't connected. Without a
   * `contacts` factory the connector does not offer `contacts.lookup`.
   */
  constructor(
    private readonly workspace: () => Promise<Workspace>,
    private readonly contacts?: () => Promise<ContactsLookup>,
  ) {
    this.capabilities = contacts ? GOOGLE_CAPABILITIES : GOOGLE_CAPABILITIES.filter((c) => c !== "contacts.lookup");
  }

  scopesFor(caps: readonly CapabilityId[]): string[] {
    return [...new Set(caps.flatMap((c) => SCOPES[c] ?? []))];
  }

  async invoke<C extends ImplementedCapability>(cap: C, input: In<C>): Promise<Out<C>> {
    if (cap === "contacts.lookup") {
      if (!this.contacts) throw new Error("google connector was built without contacts");
      const i = input as In<"contacts.lookup">;
      const out: Out<"contacts.lookup"> = await (await this.contacts()).lookup({ name: i.name, max: i.max });
      return out as Out<C>;
    }
    const ws = await this.workspace();
    switch (cap) {
      case "email.read": {
        const i = input as In<"email.read">;
        let out: Out<"email.read">;
        if (i.op === "search") out = await ws.searchGmail(i.query, i.max);
        else if (i.op === "list_ids") out = await ws.listMessageIds(i.query, i.max);
        else if (i.op === "thread") out = await ws.getThread(i.threadId);
        else if (i.op === "message") out = await ws.getMessage(i.id);
        else {
          const email = await ws.ownerEmail();
          out = email ? { email } : {};
        }
        return out as Out<C>;
      }
      case "email.draft": {
        const i = input as In<"email.draft">;
        const created = await ws.createDraft({
          to: i.to,
          ...(i.cc?.length ? { cc: i.cc } : {}),
          subject: i.subject,
          body: i.body,
          ...(i.threadId ? { threadId: i.threadId } : {}),
        });
        const out: Out<"email.draft"> = { providerDraftId: created.gmailDraftId, ...(created.threadId ? { threadId: created.threadId } : {}) };
        return out as Out<C>;
      }
      case "calendar.read": {
        const i = input as In<"calendar.read">;
        const out: Out<"calendar.read"> = await ws.listCalendarEvents({
          timeMin: i.timeMin,
          timeMax: i.timeMax,
          maxResults: i.max,
          ...(i.query ? { query: i.query } : {}),
        });
        return out as Out<C>;
      }
      case "files.read": {
        const i = input as In<"files.read">;
        const out: Out<"files.read"> = await ws.searchDrive(i.query, i.max, i.includeContent);
        return out as Out<C>;
      }
      default:
        throw new Error(`google connector does not implement ${String(cap)}`);
    }
  }
}
