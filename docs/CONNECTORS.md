# SideKiqq Connectors — Design

Status: **partly implemented.** Design 2026-10-22. Framework slice 1 (2026-10-23): capabilities +
`POLICY` table, `invokeCapability` with caller rules and an audit log (`repos/audit.ts`), the
`google` connector wrapping `GoogleWorkspace` (§8 steps 1, 2, 4: tools, cron scan and briefing all
call `invokeCapability`; `deps.workspace()` is gone), and the sender registry with
`lib/connectors/google/send.ts`. Slice 2 (2026-10-26): `ConnectionStore` (`lib/connectors/store.ts`:
per-connector AAD, `TOKEN_ENCRYPTION_KEY_PREV` rotation, single-use state carrying the PKCE verifier),
the Google token migration (§8 step 3), and per-connection enabled capabilities, granted scopes and
`needs_reauth` checked in `invokeCapability` (§4 step 3). From slice 2, still open in §7: the owner
alert on `needs_reauth`, provider revoke on disconnect, incremental scopes. Slice 3 (2026-10-28): Draft
`kind`/`connectorId`/`readback` (§5; readback built in `lib/connectors/readback.ts` and set by
`DraftsRepo.create`, used as `Action.summary`), legacy records upgraded on read, `email.draft` now
returns `{draftId, providerDraftId, readback}` and `invokeCapability` creates the Draft record, `GET
/api/drafts` adds `kind`/`readback`/`when`, sender key is `(connectorId, kind)` and approve answers 422
when none is registered. Calendar kinds are modelled only. Not yet built: §5 lazy 7-day expiry, the
generic connections routes and the Connections screen (§9), the `search_email` tool rename, and remote
MCP. Remaining difference from §2: `email.read` has two extra ops for the cron scanner (`list_ids`,
`account`).
Google `contacts.lookup` (2026-10-25, wired 2026-10-28): `brain/src/lib/google/contacts.ts` implements
the lookup (People API, saved + Other contacts); it is registered as `contacts.lookup` on the `google`
connector (input `{name, max}`), and Claude reaches it only through the `lookup_contact` tool. The §2
row reflects its output shape (`id`, `match`, `ambiguous`).
This doc is binding for connector work in the same way `ARCHITECTURE.md` is for the device contract.
If they disagree, `ARCHITECTURE.md` wins until it is updated.

Goal from the owner (2026-10-21): SideKiqq connects to any email, video and grocery service, and
runs tasks started from any device. This doc defines how, without weakening the one rule that
matters most:

> **Nothing sends a message, invites anyone, or spends money unless the owner explicitly
> confirmed that exact action, and the only route that executes a confirmed action is
> `POST /api/drafts/:id/approve`.**

---

## 1. Concepts

| Term | Meaning |
|---|---|
| **Capability** | A typed operation the brain understands, such as `email.read` or `grocery.cart.add`. Claude's tools, tasks and the dashboard are written against capabilities, never against a provider. |
| **Connector** | A provider implementation of one or more capabilities (Gmail, Outlook, Zoom, Kroger…). It is either **built-in** (TypeScript in `brain/src/lib/connectors/<id>/`) or **remote MCP** (a Model Context Protocol server the brain calls as a client). |
| **Connection** | One authorised account on a connector (for example the owner's Gmail). Single-owner system, so normally one connection per connector. |
| **Policy tier** | How a capability call is allowed to run: `auto`, `confirm` or `user_finishes` (section 4). Fixed in code per capability. |
| **Pending action** | A confirm-tier call that has been prepared but not executed. Stored as a **Draft** (section 5) and executed only by the approve route. |

Why capabilities and not raw provider tools: the policy, the audit log and the no-send test all
key off a small closed list. Adding Zoom must not add a new way to send.

---

## 2. Capability interfaces

TypeScript lives in `brain/src/lib/connectors/capabilities.ts`. Every input and output has a zod
schema. Outputs are normalised (the same `EmailSummary` from Gmail, Outlook or IMAP), so tools and
prompts do not change per provider.

| Capability | Tier | Input → Output (abridged) | Notes |
|---|---|---|---|
| `email.read` | auto | `search {query, max}` → `EmailSummary[]`; `thread {threadId}` → `EmailMessage[]`; `message {id}` → `EmailMessage` | Same shapes as today's `Workspace` (`lib/google/workspace.ts`). Query syntax is provider-native; each connector documents it in its tool description. |
| `email.draft` | auto (it *is* the email confirm step) | `DraftInput {to, cc?, subject, body, threadId?}` → `{draftId, providerDraftId?, readback}` | Creates the draft **in the provider** (Gmail/Outlook draft; for IMAP/SMTP only our record) **and** the pending Draft record, exactly as `create_email_draft` does today. Creating a draft sends nothing. |
| `email.send` | executor only | `{providerDraftId}` → `{messageId?, threadId?}` | Not a callable capability. It exists only as a sender-registry entry run by the approve route (section 6). Claude never sees it. |
| `contacts.lookup` | auto | `{name, max}` → `{contacts: Contact[] {id, name, emails[], phones[], org?, source, match}, ambiguous}` | Ambiguity is returned, not resolved: two "Dana"s → both, `ambiguous: true`, and the assistant asks. Never guesses an address. A lone partial match, or a best match from an auto-created contact (Google "Other contacts", `source: "google_other"`) when anyone else matched, is also ambiguous. `name`/`org` are untrusted third-party text. |
| `calendar.read` | auto | `{timeMin, timeMax, query?, max}` → `CalendarEvent[]` | Today's `listCalendarEvents`. |
| `calendar.hold.prepare` | **confirm** | `{title, start, end, location?}` → `{draftId, readback}` | Prepares an event on the owner's own calendar with **no attendees** (the executor asserts an empty attendee list). Still confirm: it writes to a shared-visibility calendar. |
| `calendar.invite.prepare` | **confirm** | `{title, start, end, attendees[], location?, body?, conference?: "meet"\|"zoom"}` → `{draftId, readback}` | Prepares, never creates. Any calendar write with attendees is an invite (Google puts it on attendees' calendars even with `sendUpdates: "none"`; Graph always emails), so the executor lives only in the sender registry. A Meet link is added at execute time via Calendar `conferenceData`; a Zoom room is created at execute time too (no orphan rooms). |
| `files.read` | auto | `{query, max, includeContent}` → `DriveFile[]` | Today's `searchDrive`. Generalised name so OneDrive/iCloud fit. |
| `video.create_room` | auto | `{topic, start?, durationMin?}` → `{meetingId, joinUrl, passcode?}` | Zoom only: an ad-hoc room for the owner to open ("start a Zoom"). The request body is hard-coded with no `alternative_hosts`, invitees, registrants or settings that make Zoom email anyone. Meet rooms are only made inside `calendar.invite` (Calendar `conferenceData`), so there is no Meet REST scope. No cleanup job; rooms are not deleted by the brain. |
| `grocery.search` | auto | `{query, locationId?, max}` → `Product[] {id, name, size, price?, inStock?}` | |
| `grocery.cart.add` | auto (capped) | `{items: {productId, quantity}[]}` → `{ok, count}` | No money moves. Kroger's cart API is add-only (`PUT /v1/cart/add`, 204, no read or remove), so the brain cannot undo an add and cannot report per-line results; "reversible" means the owner can remove items in the Kroger app. Caps: ≤ 50 lines per call, quantity 1–10 per line, product ids only from `grocery.search`. The assistant reads back what it asked to add. |
| `grocery.checkout` | **user_finishes** | `{}` → `Handoff {url, label}` | The brain never places an order, picks a pickup slot or touches payment. It sends the phone a link to the provider's cart (section 4.3). |
| `device.call` | **user_finishes** | `{contactId \| spokenNumber, app?: "phone"\|"whatsapp"}` → `Handoff` | Opens the dialer (`ACTION_DIAL`, never `ACTION_CALL`) with the number filled in. The number comes only from `contacts.lookup` or digits the owner spoke in this request, never from email or file text. FaceTime is for the iPhone app later. |
| `device.open_url` | **user_finishes** | `{url}` → `Handoff` | `https` only, host on a per-capability allowlist (provider cart pages, meeting join links the brain created). `sms:`, `mailto:`, `tel:`, `intent:`, `wa.me`, payment and app-link schemes are rejected. |

Capabilities that are **forbidden** and have no interface at all: payments and checkout,
deleting mail or files, changing account settings, forwarding rules, sharing files with new
people, accepting/declining invites on the owner's behalf, posting to social or group chats.
Adding one needs an owner decision recorded in this doc first.

Not in this doc (they need `docs/CHANNELS.md` first): SMS, WhatsApp messaging, Facebook groups.
When they come, an outgoing text is an `email.send`-style confirm capability (`message.send`) and
follows section 5 unchanged.

---

## 3. The brain as an MCP client

Built-in connectors and remote MCP servers implement the same `Connector` interface:

```ts
interface Connector {
  id: string;                         // "google", "outlook", "zoom", "kroger", "imap", or "mcp-<slug>"
  displayName: string;
  capabilities: CapabilityId[];        // what this connector implements
  scopesFor(caps: CapabilityId[]): string[]; // minimal OAuth scopes for the enabled caps
  invoke<C extends CapabilityId>(cap: C, input: In<C>, ctx: ConnCtx): Promise<Out<C>>;
}
```

Remote MCP connectors (`lib/connectors/mcp/`):

- Transport: MCP **Streamable HTTP** only (no stdio; Vercel functions can't host child processes).
  Authorisation per the MCP authorization spec (OAuth 2.1 with PKCE); tokens stored like any
  other connection (section 7).
- Each MCP connector ships a **manifest** in the repo (`lib/connectors/mcp/<slug>.manifest.ts`)
  that maps specific MCP tool names to capabilities, with zod schemas for arguments and an output
  adapter. Example: Kroger MCP tool `add_to_cart` → `grocery.cart.add`.
- **Unmapped MCP tools are never callable.** The brain does not pass an MCP server's tool list to
  Claude. Claude only ever sees the brain's own capability tools.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`) are hints from a third party and are
  **not** used for policy. The tier always comes from the capability in this doc.
- An MCP server cannot provide a send executor unless its manifest also provides a separate,
  non-sending `prepare` tool for the draft step. The execute step is wired into the sender
  registry like a built-in (section 6).
- Calls have a timeout (default 15 s) and the result size is capped (default 64 KB of text)
  before it reaches Claude.
- A name mapping does not limit what a third-party server *does*. So: a remote MCP connector is
  trusted only if it is self-hosted or audited, and **pinned** (server version plus a hash of its
  tool names, descriptions and schemas, checked on connect and before each call; a change marks
  the connection `needs_reauth` until the owner re-approves). If the server's own upstream grant
  can send or spend, none of its tools may map to an `auto` capability.
- The brain's MCP client advertises **no** client features: no sampling, no elicitation, no roots.
- For MCP connectors `scopesFor` is advisory: the brain cannot control what upstream scopes the
  server holds. The Connections screen says so.
- Each manifest lists its `sendTools`. The generic MCP call path rejects those names at runtime
  unless the call comes from the sender registry (section 6).

Built-in vs MCP: Google, Outlook/Microsoft 365 and IMAP/SMTP are built-in (they are core and need
the tightest control of the send path). Zoom, Kroger and future "request a connector" additions
can be either; prefer MCP when a maintained server exists and its tools map cleanly.

---

## 4. Safety policy (enforced by the brain)

All capability calls go through one function, `invokeCapability(cap, input, ctx)` in
`lib/connectors/invoke.ts`. Nothing else may call `Connector.invoke`. It:

1. Looks up the tier from the fixed `POLICY` table (code constant, section 2). Executor-only
   entries (`email.send`, the invite/hold executors) are not callable here at all.
2. Owner overrides are **not** in v1. Tiers are the table. (Tightening an auto write to confirm
   would need a non-send `executors` registry kept separate from the sender registry; add it only
   when there is a real need.) The floor is checked in code and covered by tests: send executors
   are reachable only via approve, `grocery.checkout` and `device.*` are always `user_finishes`.
3. Checks the connection is enabled for that capability.
4. Runs the tier (below) and writes an audit row: time, connector, capability, tier, caller
   (`ask` / `task` / `brief` / `cron` / `dashboard`), device, and a short summary. For
   non-first-party connectors (anything but Google and Microsoft) the arguments sent are logged
   too. Never the token, never a full email body.

### 4.1 `auto`
Runs immediately. Reads plus private writes that move no money and notify no one (create a draft, add to a cart, create an
unannounced video room).

### 4.2 `confirm`
Does **not** run. Prepares a pending action (a Draft, section 5) and returns its id to the caller
as an `Action { type: "draft_created" }`. The device then does what it already does today: shows
or reads it back, and only calls `POST /api/drafts/:id/approve` after the explicit confirmation in
`ARCHITECTURE.md` (watch tap + tap, phone dialog, the exact phrase "send it" within 30 s on
glasses/medallion/Reachy, dashboard confirm dialog). Driving mode never relaxes this.

### 4.3 `user_finishes`
Never runs in the brain. Returns a `Handoff { url | intent, label }` that is delivered to the
owner's phone (device command queue, next backlog item). The phone **never auto-launches** a
handoff: it shows a screen with the label and destination, and the owner taps to open it, then
completes it in the other app (taps Call, taps Check out). URL and number rules are in section 2.
The brain does not learn whether it was finished, and must not act as if it was.

Handoffs never appear as a new `Action.type` in `/api/ask` `actions[]` until every client has
shipped a release that tolerates it: Kotlin's `ActionType` enum has no fallback, so an unknown
value fails to parse the whole reply.

### 4.4 Untrusted content
Everything a connector returns (email bodies, file text, product names, MCP results) is data, not
instructions. The assistant prompt already says so; the policy makes it structural:

- `ctx.caller` decides what is allowed. Only owner-initiated callers (`ask`, `task`, `dashboard`)
  may run `auto` writes or create handoffs. A `task` must trace back to one specific owner request
  and cannot re-schedule itself. The cron scan (`cron`) and the briefing (`brief`) may only use
  `email.read`, `calendar.read` and `contacts.lookup`; anything else fails closed.
- Reads that send arguments to a third party (`grocery.search {query}`, any MCP tool) are also a
  leak channel. Each capability caps argument length and allowed characters (for example
  `grocery.search.query`: ≤ 80 chars, letters, digits, spaces and basic punctuation).
- Even if injected text steers the model inside an `/api/ask` loop, the worst it can reach is an
  `auto` write (a draft, a cart line, an unannounced room) or a pending confirm action that the
  owner sees read back and must confirm. It can never reach a send, an invite or a purchase.

---

## 5. Confirm-tier actions are Drafts

There is exactly one confirmation surface across all devices today: Drafts and
`POST /api/drafts/:id/approve`. Rather than add a second "confirm action" route that every device
would have to learn, confirm-tier actions become Drafts with a `kind`.

Proposed model change (implemented in the "connector framework" item, with `ARCHITECTURE.md`, TS
and Kotlin models updated together):

```ts
interface Draft {
  id; status: "pending"|"sent"|"discarded"; createdAt; sentAt?;
  kind?: "email" | "calendar_invite" | "calendar_hold";   // absent = "email" (back-compatible)
  connectorId?: string;     // absent = "google"
  providerDraftId?: string; // email only; replaces gmailDraftId (see migration below)
  providerMessageId?: string; // replaces gmailMessageId
  to: string[];             // min 1 for email and invites; empty for calendar_hold
  cc: string[]; subject: string; body: string;  // for invites: attendees in `to`, title, description
  readback: string;         // ONE sentence the device speaks before asking for "send it"
  when?: { start: string; end: string };        // invites/holds only
  threadId?; client?; followupId?;
}
```

Stored-record migration: `DraftSchema` gets a zod preprocess that maps `gmailDraftId` →
`providerDraftId` and `gmailMessageId` → `providerMessageId` on read, so pending drafts created
before the change still approve. The `to.min(1)` rule becomes a refinement that depends on `kind`.

**`readback` is built in code, never by the model.** It is a template over the structured fields:
kind, every recipient or attendee address in full, subject or title, and the time for calendar
kinds (for example "Email to dana@acme.com, cc ops@acme.com, subject 'Proposal follow-up'" or
"Calendar invite to dana@acme.com and lee@acme.com, 'Kickoff', Tue Oct 27 2–3 pm"). The model
writes none of it, so injected text in a subject or body cannot disguise who receives what. A test
covers a subject and body containing injected instructions.

- It is generated when the draft is created, not by the device. (The open QA item about a body
  summary is a separate, optional addition; the readback stays fact-only.)
- How devices learn about drafts today: phone, watch and glasses read `Action.summary` from the
  `/api/ask` reply (there is no `Draft` model in `android/shared` and no Kotlin call to
  `GET /api/drafts`); Reachy and the dashboard use `GET /api/drafts`. So:
  - `Action.summary` for `draft_created` is set to `readback` for every kind. Old devices then
    speak the true recipients without a client change.
  - `GET /api/drafts` adds `kind`, `readback` and `when`; Reachy is updated to prefer `readback`.
  - `Draft` and `GET /api/drafts` are added to `ARCHITECTURE.md`, and a `Draft` model with
    defaults for the new fields to `Models.kt`, in the framework item.
  - Calendar kinds ship only after the phone's `ApproveDraftDialog` text depends on `kind` (today
    it says "This message will be sent from your account. Review it in Gmail first").
  - `Action.type` `event_proposed` stays as is: it is a suggestion in the reply. A real invite is
    a `draft_created` with `kind: "calendar_invite"`.
- The approve route stays the only executor. It looks up the sender for `(connectorId, kind)` in
  the sender registry and runs it, with the same guards it has today (auth, pending, per-draft
  lock, re-check under lock). Each registry entry also defines its own `stillValid(draft)` check
  (→ 410 when false): provider draft still exists for Gmail/Outlook; always true for IMAP/SMTP
  (our record is the draft); for calendar kinds, the start time is still in the future.
- Expiry is checked lazily by the approve route and by `GET /api/drafts` (no new cron): a pending
  draft older than 7 days, or a calendar draft whose start has passed, is marked `discarded` and
  refused.

---

## 6. Keeping the no-send invariant testable

Before slice 1, `test/no-send.test.ts` enforced that only `lib/google/sender.ts` sent and only the approve
route reaches it. With many connectors this generalises to:

- Every send implementation lives in a file named `lib/connectors/<id>/send.ts` and exports
  functions registered in `lib/connectors/senders.ts` (the **sender registry**).
- Only `lib/deps.ts` imports `senders.ts`; only the approve route calls `deps.senders()`.
- `Connector.invoke` cannot reach a send function: the `email.send`, `calendar_invite` and
  `calendar_hold` executors are not in any connector's `invoke` switch; they exist only as
  registry entries keyed by `(connectorId, kind)`.
- The static scan's send primitives grow per connector, each allowed only in its `send.ts`:
  - Gmail: `drafts.send`, `messages.send` (note `gmail.compose` permits both), `messages.import|insert`.
  - Google Calendar: **every** event write: `events.insert|patch|update|delete|move|import|quickAdd`.
    Any of them can notify attendees, and a regex can't check a `sendUpdates` value in a variable.
    `calendar_hold` executes from `send.ts` too and asserts no attendees.
  - Microsoft Graph: `/sendMail`, `/messages/{id}/send`, `/reply`, `/replyAll`, `/forward` (these
    send at once; only `createReply`/`createReplyAll`/`createForward` make drafts), any write to
    `/events`, and `/events/{id}/forward|cancel|accept|decline|tentativelyAccept`. Graph has no
    "don't notify" option.
  - SMTP: the transport send call (for example `transporter.sendMail` / `smtp.send`), not the
    bare word `smtp`, which also appears in host config. The existing `/nodemailer|smtp/i` pattern
    is narrowed when the IMAP connector lands.
  - Zoom: meeting creation is allowed only in `lib/connectors/zoom/` with the fixed body above.
- Remote MCP: each manifest's `sendTools` are refused by the generic MCP call path at runtime
  unless the call comes from the sender registry. A static scan can't see a tool name read from
  data, so this is enforced at runtime and tested behaviourally (a hostile model calls every
  `sendTools` name directly).
- The behavioural tests run a "hostile model" for every connector: it calls every capability and
  invented tool names, and the test asserts zero sends and zero orders.

---

## 7. OAuth, tokens and scopes

Generalises `GoogleTokenStore` (`lib/google/auth.ts`) to `ConnectionStore`:

- Redis key `${prefix}:conn:<connectorId>:tokens`, value AES-256-GCM via `lib/crypto.ts` with
  `TOKEN_ENCRYPTION_KEY`, AAD `sidekiqq:conn:<connectorId>:v1` (so a ciphertext can't be replayed
  under another connector). Stored: refresh token (or app password for IMAP), account label,
  granted scopes, connectedAt. Access tokens are minted on demand and cached in memory only.
- Connect flow extends the one Google already uses: owner-authenticated `POST
  /api/connections/<id>/connect` → single-use 5-minute ticket link → provider consent with a
  single-use 10-minute `state` → `GET /api/connections/<id>/callback`. The owner secret never goes
  in a URL. **New:** PKCE on every OAuth flow (Google's current flow has none).
- **Minimal scopes, chosen per enabled capability** (incremental consent). Enabling a capability
  later asks for only the extra scope. If granted scopes come back smaller than requested, the
  missing capabilities are shown as disabled, not retried silently.
- **New:** disconnect revokes at the provider (where an endpoint exists) and deletes the stored token.
- Refresh failure (`invalid_grant` and equivalents) marks the connection `needs_reauth`, raises one
  owner alert, and makes every capability on it fail with a clear "reconnect X" error that the
  assistant speaks. It never falls back to another connector for send.
- **New:** key rotation: a second key `TOKEN_ENCRYPTION_KEY_PREV` is tried on decrypt; any successful read
  with the old key re-encrypts with the new one.

Initial scope plan (verify each against the provider's current docs when implementing):

| Connector | Capabilities | Scopes |
|---|---|---|
| Google | email.read / email.draft / email.send | `gmail.readonly`, `gmail.compose` (today's scopes; compose also permits `messages.send`, which is why the scan bans it outside `send.ts`) |
| Google | calendar.read | `calendar.readonly` (today) |
| Google | calendar.hold / calendar.invite (+ Meet link via conferenceData) | `calendar.events` (new, only when enabled) |
| Google | files.read | `drive.readonly` (today) |
| Google | contacts.lookup | `contacts.readonly`, `contacts.other.readonly` (requested since 2026-10-25; People API search needs an empty warm-up query first) |
| Microsoft 365 | email.read / email.draft | `Mail.ReadWrite`, `offline_access`, `User.Read` |
| Microsoft 365 | email.send | `Mail.Send` (only when enabled) |
| Microsoft 365 | calendar.read / contacts.lookup | `Calendars.Read`, `Contacts.Read` |
| Microsoft 365 | calendar.hold / calendar.invite | `Calendars.ReadWrite` (only when enabled) |
| Zoom | video.create_room, Zoom link in calendar.invite | `meeting:write:meeting` (granular) only |
| Kroger | grocery.search / grocery.cart.add | `product.compact`, `cart.basic:write` (Kroger's public API has no checkout or order scope, and the cart is add-only) |
| IMAP/SMTP (incl. iCloud) | email.read / email.send | app-specific password, encrypted as above; no OAuth |

---

## 8. Migrating Google onto the framework

1. Wrap `GoogleWorkspace` as the `google` connector (`email.read`, `email.draft`, `calendar.read`,
   `files.read`). No behaviour change.
2. Move `GmailDraftSender` to `lib/connectors/google/send.ts`, registered as
   `("google","email")`. Update `no-send.test.ts` paths in the same commit.
3. Token migration: on first load, if `${prefix}:google:tokens` exists and
   `${prefix}:conn:google:tokens` does not, decrypt with the old AAD
   (`sidekiqq:google-refresh-token:v1`), map fields (`refreshToken` → refresh token, `email` →
   account, `scope` → granted scopes, `connectedAt`), re-encrypt with the new AAD and write it. Keep reading the old key for one release, then delete it. `/api/google/connect`
   and `/api/google/callback` stay as aliases of the generic routes for one release.
4. Every direct `deps.workspace()` caller moves to `invokeCapability`: the Claude tools
   (`caller: "ask"`), the cron scanner (`"cron"`) and the briefing (`"brief"`). After this step
   `deps.workspace()` is removed, so nothing skips the policy or the audit log. Claude tools keep their names where possible (`search_gmail` becomes `search_email` with the old name kept as an alias for one
   release) so prompts and tests move gradually.

---

## 9. Owner surfaces

Dashboard **Connections** screen (`/dashboard/connections`, signed-session auth like the rest):
one row per connector with status (`connected`, `needs_reauth`, `error`, `disabled`, `not
connected`), account label, enabled capabilities with their tier shown as plain words ("reads
automatically", "asks you first", "you finish on your phone"), last used, Connect / Reconnect /
Disconnect. Tiers are shown, not editable, in v1.

Owner API (owner secret header or dashboard session; not device tokens):

| Method | Path | Returns |
|---|---|---|
| GET | /api/connections | `{ items: Connection[] }` |
| POST | /api/connections/:connectorId/connect | `{ url, expiresAt }` (single-use link) |
| GET | /api/connections/:connectorId/callback | redirect to the dashboard |
| POST | /api/connections/:connectorId/disconnect | `{ ok: true }` |
| POST | /api/connections/:connectorId/capabilities | `{ enabled: CapabilityId[] }` → `Connection` |

```ts
interface Connection { connectorId: string; displayName: string;
  status: "connected"|"needs_reauth"|"error"|"disabled"|"not_connected";
  account?: string; capabilities: { id: CapabilityId; enabled: boolean; tier: Tier }[];
  connectedAt?: string; lastUsedAt?: string; lastError?: string; }
```

Devices get no new endpoints for connectors. They see results through `/api/ask` replies, Drafts
and (later) handoffs in the device command queue.

---

## 10. Build order (maps to the backlog)

1. **Connector framework** — capabilities, `invokeCapability` + policy table with floor tests,
   `ConnectionStore`, sender registry, Draft `kind`/`readback`, Google migration, Connections
   screen. Contract updates in `ARCHITECTURE.md` (add `Draft` and `GET /api/drafts`) + TS +
   Kotlin (add a `Draft` model).
2. **Task layer + device routing** — device command queue that delivers `Handoff`s.
3. **Google Contacts** — `contacts.lookup`.
4. **"Email this to <contact>"** task on top of 1 + 3.
5. **Meet / Zoom** — `video.create_room`, `calendar.invite.prepare` (confirm), phone call hand-offs.
6. **Kroger** — `grocery.search`, `grocery.cart.add`, `grocery.checkout` hand-off.
7. **Outlook / IMAP-SMTP / iCloud**, then the "request a connector" flow (the generated connector
   ships a manifest and a PR; it is never enabled until the owner merges and connects it).

## 11. Open questions for the owner

- Should `calendar.hold.prepare` (own calendar, no attendees) be `auto` instead of `confirm`? This doc
  picks `confirm` as the safer default.
- Should `grocery.cart.add` read the list back and ask once before adding? This doc picks `auto`
  with a read-back afterwards, since nothing is bought and the owner can remove items in the
  Kroger app (the brain itself can't remove them).
- Instacart: its developer platform appears to create shareable shopping-list links rather than
  fill a user's cart; confirm its terms before designing an Instacart connector.
