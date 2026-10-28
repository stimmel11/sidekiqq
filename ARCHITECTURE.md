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
| POST | /api/drafts/:id/approve | – | `{ "ok": true }` — the ONLY path that sends a message, and only after user approval |
| GET | /api/alerts?since=<cursor>&limit=<1..100> | – | `{ "items": Alert[], "cursor": string, "more": boolean }` — the proactive alerts that FCM pushes carry, for devices without FCM. Oldest first; no `since` = last 24 h; `more` = call again now |
| POST | /api/speak | `{ "text": string (<= SPEAK_MAX_CHARS, default 1000), "voice"?: "alloy"\|"ash"\|"ballad"\|"coral"\|"echo"\|"fable"\|"nova"\|"onyx"\|"sage"\|"shimmer"\|"verse" }` | `audio/wav` bytes: PCM 16-bit LE, mono, 24 kHz (rate also in `X-Sample-Rate`). 413 if text is too long |
| POST | /api/commands | `CreateCommandRequest` | `201 { "command": DeviceCommand, "deviceId": string, "device": DeviceKind }`. Queues a command started on this device to run on another. 400 bad fields/URL/number, 404 unknown `target.deviceId`, 409 no device that can run it (`no_target_device`, `wrong_target`), 429 `queue_full` |
| GET | /api/commands?limit=<1..50> | – | `{ "items": DeviceCommand[] }` — this device's pending, unexpired commands, oldest first. A command stays listed until acked or expired, so dedupe by `id` |
| POST | /api/commands/:id/ack | `{ "result": "opened"\|"dismissed"\|"failed" }` | `{ "ok": true }`. Target device only (others get 404). Same result again is a no-op; a different one is 409; `opened` after `expiresAt` is 410 |
| POST | /api/devices/register | `{ "fcmToken": string, "device": string }` | `{ "ok": true }` |
| POST | /api/cron/scan | (Vercel Cron, secret header) | scans Gmail, extracts commitments, pushes alerts |

`spoken` is a short (<= 2 sentences) version of `reply` for watch TTS and glasses audio.

Pairing / owner endpoints (not device-token auth):

| Method | Path | Auth | Body → Returns |
|---|---|---|---|
| POST | /api/devices/pair-code | owner secret header | `{ "label"?: string }` → `{ "code": "123456", "expiresAt": string, "ttlSeconds": number }` |
| POST | /api/devices/pair | none (one-time code, rate-limited per IP) | `{ "code": string, "device": "watch"\|"glasses"\|"medallion"\|"phone"\|"reachy", "name"?: string }` → `{ "token": string, "deviceId": string, "device": string }` |
| POST | /api/google/connect | owner secret header | → `{ "url": string, "expiresAt": string }` (one-time browser link) |

Push (FCM) messages are **data-only**: `title`, `body`, `kind` ("email"\|"commitment_overdue"), optional
`importance`, `client`, `messageId`, `threadId`, `commitmentId`. The phone builds the notification itself.
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
interface Action { type: "draft_created"|"commitment_added"|"event_proposed"; id: string; summary: string; }
interface Brief { kind; generatedAt; sections: { title: string; items: string[] }[]; top5: TopItem[]; }
type DeviceKind = "watch"|"glasses"|"medallion"|"phone"|"reachy";
interface Alert { id: string /* sequence no. = cursor */; at: string; title: string; body: string;
  kind: "email"|"commitment_overdue"; importance?: Importance; priority: "high"|"normal";
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
- This endpoint is the owner-device path. Hand-offs created later from `/api/ask` or connectors go through
  `invokeCapability` with the caller rules and per-capability allowlists in `docs/CONNECTORS.md` §4.4.
- Commands expire after 15 minutes; at most 20 pending per device. Delivery is polling (`GET /api/commands`) for now;
  an FCM nudge is a later slice.

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

`reachy_wake` on Reachy: the robot has no screen, so the owner's tap is the one on the device that created the command
(only paired owner devices can). Reachy polls `GET /api/commands` every 30 s (or the alert interval if shorter, same
backoff) and runs a wake only while the latest successful GET lists it: `chat` = greeting + one Talk-style listen,
`brief` = daily brief, `dance` = motion only, `game` = not built yet (spoken "coming soon", acked `failed`); an unknown
`activity` does nothing and is acked `failed`. A wake never interrupts a turn, listening, speech or a pending "send it":
it waits for an idle robot, and is acked `dismissed` without acting if it waited more than 2 minutes. Handled ids are
claimed and persisted before acting, so re-delivery, lost acks or a restart never repeat one (lost acks are re-sent
while the command is still listed). Kinds Reachy doesn't run are ignored and not acked.

## Connectors
Connecting more services (Outlook, IMAP, Zoom, Meet, Kroger, remote MCP servers) follows `docs/CONNECTORS.md` (framework
slice 1 implemented: every Gmail/Calendar/Drive call goes through `invokeCapability` and its fixed policy table): capability interfaces, a fixed per-capability safety policy, and confirm-tier actions stored as Drafts so
`/api/drafts/:id/approve` stays the only executor.

## Auth
Single-owner system. Brain issues long-lived device tokens via a one-time pairing code shown on the phone
(`/api/devices/pair`). Google OAuth tokens live server-side only (encrypted in Redis).
