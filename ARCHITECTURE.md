# SideKiqq — Wearable AI Executive Assistant

One cloud "brain" plus three wearable surfaces. Every device is a thin client:
it captures a voice request (or shows a glanceable summary) and the brain does
the thinking.

```
 [Medallion] --BLE audio--> [Phone companion] <--Wearable Data Layer--> [Galaxy Watch]
                               |    \
                               |     \--Jetpack Projected (audio)--> [Galaxy Glasses]
                               v
                     HTTPS  [SideKiqq Brain on Vercel]
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
```

## Brain API contract (all JSON, all require `Authorization: Bearer <device token>`)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/ask | `{ "text": string, "device": "watch"\|"glasses"\|"medallion"\|"phone", "conversationId"?: string }` | `{ "reply": string, "spoken": string, "conversationId": string, "actions": Action[] }` |
| POST | /api/transcribe | raw audio body, `Content-Type: audio/wav` (16 kHz mono 16-bit PCM) | `{ "text": string }` |
| GET | /api/brief?kind=daily\|eod\|weekly | – | `Brief` |
| GET | /api/top5 | – | `{ "items": TopItem[], "updatedAt": string }` |
| GET | /api/followups | – | `{ "items": FollowUp[] }` |
| GET | /api/commitments?status=open\|overdue\|all | – | `{ "items": Commitment[] }` |
| POST | /api/commitments/:id/complete | – | `{ "ok": true }` |
| POST | /api/drafts/:id/approve | – | `{ "ok": true }` — the ONLY path that sends a message, and only after user approval |
| POST | /api/devices/register | `{ "fcmToken": string, "device": string }` | `{ "ok": true }` |
| POST | /api/cron/scan | (Vercel Cron, secret header) | scans Gmail, extracts commitments, pushes alerts |

`spoken` is a short (<= 2 sentences) version of `reply` for watch TTS and glasses audio.

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
```

## Safety rules baked in (from the EA operating system)
- Nothing is ever sent automatically. The brain creates drafts; sending requires `/api/drafts/:id/approve`,
  which every device surfaces as an explicit confirm (watch: tap Approve; glasses: say "send it" then confirm).
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

## Auth
Single-owner system. Brain issues long-lived device tokens via a one-time pairing code shown on the phone
(`/api/devices/pair`). Google OAuth tokens live server-side only (encrypted in Redis).
