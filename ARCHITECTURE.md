# SideKiqq — Wearable AI Executive Assistant

One cloud "brain" plus three wearable surfaces and a desktop robot (Reachy Mini). Every device is a thin client:
it captures a voice request (or shows a glanceable summary) and the brain does
the thinking.

```
 [Medallion] --BLE audio--> [Phone companion] <--Wearable Data Layer--> [Galaxy Watch]
                               |    \
                               |     \--Jetpack Projected (audio)--> [Galaxy Glasses]
                               v
                     HTTPS  [SideKiqq Brain on Vercel] <--HTTPS (polls /api/alerts)-- [Reachy Mini desktop robot]
                               |-- Claude API (EA operating rules)
                               |-- Gmail / Google Calendar / Google Drive (OAuth)
                               |-- Upstash Redis (commitments, open loops, clients, timeline)
                               \-- FCM push (proactive alerts)
```

## Repo layout
```
/brain      Next.js 15 (App Router) + TypeScript, deployed to Vercel
/android    Gradle multi-module project
  /shared   Kotlin API client + models (used by phone and watch)
  /phone    Phone companion app (also hosts the Galaxy Glasses experience)
  /watch    Wear OS app for Galaxy Watch
/medallion  ESP32-S3 firmware (PlatformIO, Arduino framework) + hardware guide
/reachy     Reachy Mini app (Python package `sidekiqq_reachy`, published as a Hugging Face Space)
```

## Brain API contract (all JSON, all require `Authorization: Bearer <device token>`)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/ask | `{ "text": string, "device": "watch"\|"glasses"\|"medallion"\|"phone"\|"reachy", "conversationId"?: string }` | `{ "reply": string, "spoken": string, "conversationId": string, "actions": Action[] }` |
| POST | /api/transcribe | raw audio body, `Content-Type: audio/wav` (16 kHz mono 16-bit PCM) | `{ "text": string }` |
| GET | /api/brief?kind=daily\|eod\|weekly | – | `Brief` |
| GET | /api/top5 | – | `{ "items": TopItem[], "updatedAt": string }` |
| GET | /api/followups | – | `{ "items": FollowUp[] }` |
| GET | /api/commitments?status=open\|overdue\|all | – | `{ "items": Commitment[] }` |
| POST | /api/commitments/:id/complete | – | `{ "ok": true }` |
| GET | /api/drafts | – | `{ "items": DraftItem[] }` — pending drafts awaiting approval. Speak or show `readback` before asking for confirmation. Calendar drafts whose start has passed are marked discarded and not listed |
| POST | /api/drafts/:id/approve | – | `{ "ok": true, "warning"?: string }` (`warning`: sent, but not exactly as read back, e.g. "no Meet link"; show/speak it) — the ONLY path that sends a message, and only after user approval. 409 `not_pending` / `in_progress`, 409 `changed_in_provider` (To/Cc/Bcc/Subject edited in Gmail since the read-back; marked discarded, nothing sent), 410 `gone` (the provider draft is gone; marked discarded), 410 `expired` (a calendar invite whose start time has passed; marked discarded), 422 `unsupported_kind` (no executor for this kind yet), `no_provider_draft` (email) or `invalid_draft` (other kinds), 422 `provider_refused` (the provider definitely refused it, e.g. missing calendar permission; still pending); nothing is sent on any error |
| POST | /api/drafts/:id/discard | – | `{ "ok": true }` — marks a pending draft discarded. Never sends |
| GET | /api/alerts?since=<cursor>&limit=<1..100> | – | `{ "items": Alert[], "cursor": string, "more": boolean }` — the proactive alerts that FCM pushes carry, for devices without FCM. Oldest first; no `since` = last 24 h; `more` = call again now |
| POST | /api/speak | `{ "text": string (<= SPEAK_MAX_CHARS, default 1000), "voice"?: "alloy"\|"ash"\|"ballad"\|"coral"\|"echo"\|"fable"\|"nova"\|"onyx"\|"sage"\|"shimmer"\|"verse" }` | `audio/wav` bytes: PCM 16-bit LE, mono, 24 kHz (rate also in `X-Sample-Rate`). 413 if text is too long |
| POST | /api/commands | `CreateCommandRequest` | `201 { "command": DeviceCommand, "deviceId": string, "device": DeviceKind }`. Queues a command started on this device to run on another. 400 bad fields/URL/number, 404 unknown `target.deviceId`, 409 no device that can run it (`no_target_device`, `wrong_target`), 429 `queue_full` |
| GET | /api/commands?limit=<1..50> | – | `{ "items": DeviceCommand[] }` — this device's pending, unexpired commands, oldest first. A command stays listed until acked or expired, so dedupe by `id` |
| POST | /api/commands/:id/ack | `{ "result": "opened"\|"dismissed"\|"failed" }` | `{ "ok": true }`. Target device only (others get 404). Same result again is a no-op; a different one is 409; `opened` after `expiresAt` is 410 |
| POST | /api/devices/register | `{ "fcmToken": string, "device": string }` | `{ "ok": true }` |
| POST | /api/cron/scan | (Vercel Cron, secret header) | scans Gmail, extracts commitments, pushes alerts |

`spoken` is a short (<= 2 sentences) version of `reply` for watch TTS and glasses audio.

Drafts: every action the owner must confirm is a stored Draft (`docs/CONNECTORS.md` §5). `kind: "email"` and
`kind: "calendar_invite"` (from the `/api/ask` tool `create_calendar_invite`, optionally with a Google Meet link) are
created and approvable; approving an invite inserts the event on the owner's Google Calendar and Google emails every
attendee. `calendar_hold` is modelled only (422 `unsupported_kind`). Devices word their confirm step by kind
(`Action.draftKind` / `DraftItem.kind`) and never offer to approve a kind they don't know. The stored record also has `status`, `connectorId` (absent = `"google"`), `providerDraftId`
(replaces `gmailDraftId`), `providerMessageId` (replaces `gmailMessageId`), `threadId`, `followupId` and `sentAt`;
records written before these fields existed are upgraded on read, so old pending drafts still list and approve.
Recipients are strict bare ASCII addresses (`name@example.com`, IDN only as `xn--` punycode; no display names,
lists or groups), at most 5 To and 5 Cc.

Pairing / owner endpoints (not device-token auth):

| Method | Path | Auth | Body → Returns |
|---|---|---|---|
| POST | /api/devices/pair-code | owner secret header | `{ "label"?: string }` → `{ "code": "123456", "expiresAt": string, "ttlSeconds": number }` |
| POST | /api/devices/pair | none (one-time code, rate-limited per IP) | `{ "code": string, "device": "watch"\|"glasses"\|"medallion"\|"phone"\|"reachy", "name"?: string }` → `{ "token": string, "deviceId": string, "device": string }` |
| POST | /api/google/connect | owner secret header | → `{ "url": string, "expiresAt": string }` (one-time browser link). Alias of the connections route below for one release |
| GET | /api/connections | owner secret header or dashboard session | → `{ "items": Connection[] }` |
| POST | /api/connections/:connectorId/connect | owner secret header or dashboard session | → `{ "url": string, "expiresAt": string }` (single-use 5-min link; `GET` on it starts the provider sign-in) |
| GET | /api/connections/:connectorId/callback | none (single-use OAuth `state` + PKCE) | redirects to `/dashboard/connections?connect=<code>` |
| POST | /api/connections/:connectorId/disconnect | owner secret header or dashboard session | → `{ "ok": true, "revoked": boolean }` (provider revoke is best effort; the stored sign-in is always deleted) |
| POST | /api/connections/:connectorId/capabilities | owner secret header or dashboard session | `{ "enabled": CapabilityId[] }` → `Connection`. Only that connector's own capabilities; tiers are fixed in code |
| GET / POST | /api/connector-requests | owner secret header | "Request a connector" log, see `docs/CONNECTOR_REQUESTS.md`. Logging a request builds, connects and enables nothing |
| PATCH | /api/connector-requests/:id | owner secret header | `{ "status"?, "prUrl"?, "note"? }` → `{ "request" }` (owner bookkeeping only) |

Device tokens are never accepted on `/api/connections*` (a device token plus a session cookie is refused too). `Connection`
is defined in `docs/CONNECTORS.md` §9. Devices get no connector endpoints.

Push (FCM) messages are **data-only**: `title`, `body`, `kind` ("email"\|"commitment_overdue"\|"connection_needs_reauth"), optional
`importance`, `client`, `messageId`, `threadId`, `commitmentId`. The phone builds the notification itself.
One more FCM data message is **not an alert**: the command nudge `{ "kind": "command", "commandId": string }`, with
no `title`/`body`, sent only to the target device of a newly queued command (see Device commands). Clients must check
`kind` first and never show, relay or log it as an alert.
Every alert is also written to a 7-day alert log (`lib/push/alerts.ts` → `deliverAlert`), so `GET /api/alerts`
returns exactly the same title/body/data as the push.

### Models (TypeScript names; Kotlin mirrors them in /android/shared)
```ts
type Importance = "CRITICAL"|"HIGH"|"MEDIUM"|"LOW"|"FYI";
type Confidence = "CONFIRMED"|"LIKELY"|"INFERRED"|"UNKNOWN";
interface Commitment { id; who: string; what: string; madeAt: string; dueAt?: string;
  dueInferred: boolean; status: "open"|"done"|"overdue"; client?: string; project?: string;
  source: { kind: "email"|"meeting"|"voice"; ref?: string }; confidence: Confidence; }
interface FollowUp { id; person: string; client?: string; reason: string; daysQuiet?: number;
  importance: Importance; suggestedMessage?: string; draftId?: string; }
interface TopItem { id; title: string; why: string; importance: Importance; dueAt?: string; }
interface Action { type: "draft_created"|"commitment_added"|"event_proposed"; id: string;
  summary: string /* for draft_created: the draft's `readback` */;
  draftKind?: DraftKind /* draft_created only; absent from older brains = "email" */; }
type DraftKind = "email"|"calendar_invite"|"calendar_hold";  // clients must not offer to approve kinds they don't know
interface DraftItem { id: string; kind: DraftKind /* absent from older brains = "email" */;
  to: string[] /* recipients, or attendees for calendar_invite; empty for calendar_hold */; cc: string[];
  subject: string /* or event title */; body: string /* or event description */;
  readback: string /* ONE sentence (<= 1000 chars), built by the brain in code, never by the model: kind, every
                      address in full, the time for calendar kinds, "with a Google Meet link" for invites that add
                      one, then "with the subject: <subject>." (invites: "with the title: <title>", then ", and the
                      location: <location>." when set; both cleaned of addresses/format characters). Absent from
                      older brains. Speak any body excerpt after it behind an explicit marker ("Message begins:") */;
  when?: { start: string; end: string } /* calendar kinds only */;
  location?: string /* calendar kinds only */; conference?: "meet" /* calendar_invite only: Meet link added when sent */;
  client?: string; createdAt: string; }
interface Brief { kind; generatedAt; sections: { title: string; items: string[] }[]; top5: TopItem[]; }
type DeviceKind = "watch"|"glasses"|"medallion"|"phone"|"reachy";
interface Alert { id: string /* sequence no. = cursor */; at: string; title: string; body: string;
  kind: "email"|"commitment_overdue"|"connection_needs_reauth" /* clients show unknown kinds as plain alerts */;
  importance?: Importance; priority: "high"|"normal";
  client?: string; messageId?: string; threadId?: string; commitmentId?: string; }
type CommandKind = "open_url"|"call_contact"|"reachy_wake";   // clients must ignore kinds they don't know
interface DeviceCommand { id: string; at: string; expiresAt: string /* at + 15 min */; kind: CommandKind;
  label: string /* built by the brain; shown before the owner taps */; from: DeviceKind;
  url?: string /* open_url */; number?: string; name?: string; app?: "phone"|"whatsapp" /* call_contact */;
  activity?: "chat"|"brief"|"dance"|"game" /* reachy_wake */; }
interface CreateCommandRequest { kind: CommandKind; target?: { deviceId?: string; device?: DeviceKind } /* one, not both (400) */;
  url?: string; number?: string; name?: string; app?: "phone"|"whatsapp"; activity?: "chat"|"brief"|"dance"|"game"; }
```

### Device commands (task layer + device routing)
A command is started on one device and runs on another ("call Dana" said to the watch opens the dialer on the phone).
Every command is a **hand-off** (`user_finishes` in `docs/CONNECTORS.md`): the target shows `label` and acts only after
the owner taps. Devices never auto-launch a command, dial with `ACTION_DIAL` (never `ACTION_CALL`), and nothing is ever
sent because of a command; messages still go only through `/api/drafts/:id/approve`.
- Targets: `open_url` and `call_contact` → `phone`; `reachy_wake` → `reachy`. Default is the most recently seen
  non-revoked device of that kind; `target.deviceId` picks one.
- `open_url`: `https` only, no credentials or port, host on a code allowlist (`meet.google.com`, `zoom.us` and its
  subdomains, `www.kroger.com`, `www.kingsoopers.com`).
- `call_contact`: digits with optional `+ ( ) . -` and spaces, 3–15 digits; `*`, `#`, `,` and `;` are rejected (no
  MMI/USSD codes or post-dial digits). WhatsApp needs a leading `+`. Short codes such as 911 are accepted: the owner
  still taps Call in the dialer. `name` loses digits, `+` and brackets so it can't carry a fake number; devices show
  `number` on its own line, not only inside `label`.
- Liveness: a device treats a command as live only while `GET /api/commands` returns it. An `opened` ack is accepted up
  to 60 s after `expiresAt` (a tap made in time, acked late); after that it is 410 and purely informational.
- `POST /api/commands` is the owner-device path. "Call Dana on my phone" said to any device goes through `/api/ask`:
  Claude's `call_on_phone` tool queues a `call_contact` for the phone (`from` = the asking device). Its number comes only
  from the clear match of a `lookup_contact` in the same request (a saved contact's id, plus which of its numbers when
  it has several; any candidate of an ambiguous lookup, and Google "Other contacts", are refused so the assistant asks)
  or from a whole number span in the owner's request text; never a number the model typed from email, files or
  calendar (`lib/commands/call.ts`). One call per request; every attempt, refusals included, is audited as
  `device.call` / `user_finishes`. No new `Action.type`: the reply says it is waiting on the
  phone. Other connector hand-offs will go through `invokeCapability` with the caller rules in `docs/CONNECTORS.md` §4.4.
- Commands expire after 15 minutes; at most 20 pending per device. Delivery is polling (`GET /api/commands`), plus a
  best-effort FCM nudge to the target device's own push token right after a command is queued (`POST /api/commands` or `call_on_phone`) (high priority,
  data-only `{ kind: "command", commandId }`, 3 s timeout, never fails the request; devices without a token, e.g.
  Reachy, just poll). The nudge carries no label, number or URL: the command is read only from `GET /api/commands`.
  The phone polls at once if visible, otherwise posts one generic "Hand-off waiting" notification (no content, no
  action except opening the app). A nudge is never an alert: not in the alert log, not relayed to the watch, no
  medallion haptic.

## Safety rules baked in (from the EA operating system)
- Nothing is ever sent automatically. The brain creates drafts; sending requires `/api/drafts/:id/approve`,
  which every device surfaces as an explicit confirm (watch: tap Approve; glasses, medallion and Reachy Mini: the
  exact phrase "send it" within 30 s of hearing the draft read back; anything else, silence or a timeout cancels).
- Inferred dates and facts carry `dueInferred` / `confidence` and are spoken as "inferred".
- Client data is never mixed across clients in replies.

## Medallion BLE protocol (GATT)
Service `5a1d0001-5e1d-4b1a-9e1d-51de4b1a0001`
- `…0002` AUDIO (notify): 16 kHz mono PCM16, chunks of up to 240 bytes, first byte = sequence counter (uint8)
- `…0003` CONTROL (write/notify): 0x01 start-of-utterance, 0x02 end-of-utterance, 0x03 cancel,
  0x10 phone→medallion "thinking" (pulse LED), 0x11 "reply delivered" (short haptic), 0x12 "needs attention" (double haptic)
- `…0004` BATTERY (read/notify): uint8 percent
Phone reassembles audio → WAV → `/api/transcribe` → `/api/ask` (device: "medallion") → speaks reply on glasses/earbuds,
shows it on watch. The medallion itself has no speaker.

## Reachy Mini (desktop robot)
A Reachy Mini app (`/reachy`, Python, runs under the Reachy Mini daemon). It talks to the brain directly over HTTPS
with its own device token (device kind `"reachy"`): mic → endpointing → 16 kHz WAV → `/api/transcribe` → `/api/ask`
→ `/api/speak` → robot speaker. It polls `/api/alerts` about every 60 s instead of FCM. Activation is tap-to-talk
from its settings page (port 8042); an on-device wake word is optional and off by default, so room audio is not
streamed to the cloud. Draft approval uses the same "send it" rule and still goes only through `/api/drafts/:id/approve`.
The brain can't reach the home LAN, so the **phone** starts Reachy: on the owner's tap (Reachy card: Chat / Brief /
Dance) it calls the robot's daemon over plain HTTP at a `.local` mDNS name (default `reachy-mini.local:8000`):
`GET /api/apps/current-app-status`, then `POST /api/apps/start-app/sidekiqq_reachy/no-evict` (plain `start-app` only
if that route is 404). It never stops or evicts another app or remote session, sends the daemon no token or owner
data, and doesn't follow redirects. Once the app reports `running`, the phone queues `reachy_wake` with
`POST /api/commands` (`target.device: "reachy"`); that tap is the hand-off's "user finishes" step.

`reachy_wake` on Reachy: the robot has no screen, so the owner's tap is the one on the device that created the command
(only paired owner devices can). Reachy polls `GET /api/commands` every 30 s (or the alert interval if shorter, same
backoff) and runs a wake only while the latest successful GET lists it: `chat` = greeting + one Talk-style listen,
`brief` = daily brief, `dance` = motion only, `game` = not built yet (spoken "coming soon", acked `failed`); an unknown
`activity` does nothing and is acked `failed`. A wake never interrupts a turn, listening, speech or a pending "send it":
it waits for an idle robot, and is acked `dismissed` without acting if it waited more than 2 minutes (a `chat`, which
opens the mic, also if its `at` is more than 2 minutes + 60 s clock skew old). Handled ids are
claimed and persisted before acting, so re-delivery, lost acks or a restart never repeat one (lost acks are re-sent
while the command is still listed). Kinds Reachy doesn't run are ignored and not acked.

## Connectors
Connecting more services (Outlook, IMAP, Zoom, Meet, Kroger, remote MCP servers) follows `docs/CONNECTORS.md` (framework
slices 1–4 implemented: every Gmail/Calendar/Drive/Contacts call goes through `invokeCapability` and its fixed policy table;
`email.draft` creates the pending Draft with its code-built `readback`; the owner manages connections on the dashboard Connections
screen; a refresh failure marks the connection `needs_reauth` and raises one `connection_needs_reauth` alert): capability interfaces, a fixed per-capability safety policy, and confirm-tier actions stored as Drafts so
`/api/drafts/:id/approve` stays the only executor.

## Auth
Single-owner system. Brain issues long-lived device tokens via a one-time pairing code shown on the phone
(`/api/devices/pair`). Google OAuth tokens live server-side only (encrypted in Redis).
