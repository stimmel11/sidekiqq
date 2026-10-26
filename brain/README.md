# SideKiqq Brain

The cloud "brain" for SideKiqq, a wearable AI executive assistant. Every device (phone, Galaxy Watch, Galaxy Glasses,
medallion) is a thin client. This service does the thinking: Claude with the EA operating system, Gmail/Calendar/Drive,
commitments and open loops in Upstash Redis, and FCM push alerts.

Next.js 15 (App Router) + TypeScript (strict), deployed to Vercel. The API contract in `../ARCHITECTURE.md` is binding.

## API

All endpoints take and return JSON and require `Authorization: Bearer <device token>` unless the table says otherwise.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/ask` | `{ text, device, conversationId? }` → `{ reply, spoken, conversationId, actions }` |
| POST | `/api/transcribe` | raw `audio/wav` (16 kHz mono PCM16, ≤120 s) → `{ text }` |
| GET | `/api/brief?kind=daily\|eod\|weekly` | `Brief` |
| GET | `/api/top5` | `{ items: TopItem[], updatedAt }` (cached up to 1 h, invalidated on changes) |
| GET | `/api/followups` | `{ items: FollowUp[] }` |
| GET | `/api/commitments?status=open\|overdue\|all` | `{ items: Commitment[] }` (`open` = not done, overdue included) |
| POST | `/api/commitments/:id/complete` | `{ ok: true }` |
| POST | `/api/drafts/:id/approve` | `{ ok: true }`. **The only code path that sends email.** |
| POST | `/api/devices/register` | `{ fcmToken, device }` → `{ ok: true }` (attaches FCM token to the calling device) |
| GET/POST | `/api/cron/scan` | `Authorization: Bearer $CRON_SECRET` (Vercel Cron, every 30 min) |
| POST | `/api/devices/pair-code` | **Owner secret** (`Authorization: Bearer $OWNER_SECRET` or `X-Owner-Secret`). Body `{ label? }` → `{ code, expiresAt, ttlSeconds }` |
| POST | `/api/devices/pair` | **No auth.** `{ code, device, name? }` → `{ token, deviceId, device }` |
| POST | `/api/google/connect` | **Owner secret** (header). → `{ url, expiresAt }`: a one-time browser link (`?ticket=`, 5 min) |
| GET | `/api/google/connect` | Owner secret header **or** one-time `?ticket=`. Redirects to Google consent. `?secret=` is refused (it would be logged). |
| GET | `/api/google/callback` | OAuth redirect target |
| GET | `/api/drafts` | *Extension:* pending drafts awaiting approval |
| POST | `/api/drafts/:id/discard` | *Extension:* discard a pending draft (never sends) |
| GET | `/api/health` | *Extension:* unauthenticated liveness |

Errors are `{ error, code? }` with status 400 (validation, with `issues`), 401, 404, 409 (draft not pending or
already sending), 410 (Gmail draft deleted), 413/415/422 (audio), 429 (pairing rate limit), 502 (STT provider),
503 (server not configured).

### Pairing flow
1. The owner (phone app settings, or curl) calls `POST /api/devices/pair-code` with the owner secret and gets a 6-digit code (single use, 10 min).
2. The device calls `POST /api/devices/pair` with the code and gets a long-lived `token`. Store it in Android Keystore / EncryptedSharedPreferences.
3. The device calls `POST /api/devices/register` with its FCM token.

Only a SHA-256 hash of each device token is stored. Pair attempts are limited to 10 per IP per 15 minutes.

### FCM payload
Push messages carry `notification {title, body}` and `data` with `kind` (`email` | `commitment_overdue`), `importance`,
and `messageId`/`threadId`/`commitmentId`/`client` where relevant. Android channel id: `sidekiqq_alerts`. CRITICAL
alerts use high priority.

## How it works

- **System prompt**: `prompts/operating-system.md` is loaded verbatim at runtime and sent as a cached system block.
  Runtime context (time, device, tool protocol) goes in a second block.
- **/api/ask**: a Claude tool-use loop with `search_gmail`, `get_email_thread`, `list_calendar_events`, `search_drive`,
  `get_client_timeline`, `list_commitments`, `add_commitment`, `update_commitment`, `list_followups`,
  `create_email_draft`, `record_decision`, `upsert_client_profile`. The model ends by calling `respond {reply, spoken}`;
  on the last allowed iteration that tool is forced. `spoken` is enforced server-side to ≤2 sentences / 280 chars with
  markdown, URLs and ids stripped. History is kept in Redis per `conversationId` with a sliding TTL.
- **Cron scan**: pulls inbox and sent mail since the last scan, then has Claude categorize, score importance and extract
  commitments, decisions and follow-ups (labeled CONFIRMED/LIKELY/INFERRED, with `dueInferred` when guessed). It stores
  them with timeline events and pushes for CRITICAL/HIGH mail and overdue commitments (once per commitment per day).
  Messages are de-duplicated, failures are retried on the next run, and a Redis lock prevents overlapping runs.
- **Safety**: nothing is sent automatically. The `Workspace` interface (read + draft) has no send method. Sending lives in
  `src/lib/connectors/google/send.ts` (registered in the sender registry `src/lib/connectors/senders.ts`) and is reachable only from `/api/drafts/:id/approve`, which checks that the draft exists and
  is `pending`, takes a per-draft lock against double taps, and confirms the Gmail draft still exists.
  `test/no-send.test.ts` fails if any other file gains a send primitive.
- **Connector tokens**: `ConnectionStore` (`src/lib/connectors/store.ts`) encrypts each connector's refresh token
  with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`, AAD `sidekiqq:conn:<connector>:v1`) in Redis, supports key rotation via
  `TOKEN_ENCRYPTION_KEY_PREV`, and stores per-connection status and enabled capabilities. Google OAuth uses PKCE.
  Access tokens are never persisted.

```
src/
  app/api/...            route handlers (thin: auth, validate, call lib)
  middleware.ts          edge pre-filter (rejects API calls with no credentials)
  lib/
    models.ts            zod schemas = contract models + internal records
    auth.ts              device-token / owner-secret / cron guards, withDevice()
    deps.ts              dependency container (fakes injected in tests)
    kv.ts                KV interface + Upstash implementation
    repos/               commitments, followups, clients, timeline, decisions, drafts, devices, conversations, pairing, state
    assistant/           Claude client, prompt loader, tools, ask loop, spoken guard
    scan/                Gmail scan + extraction schema/parser
    briefing/            daily/eod/weekly briefs + Top 5
    google/              OAuth + encrypted token store, Workspace (read/draft), sender (approve-only)
    transcribe/          Transcriber interface, OpenAI Whisper + Deepgram via fetch, WAV validation
    push/                FCM sender (firebase-admin)
prompts/operating-system.md
test/                    vitest (in-memory Redis fake, scripted Claude, fake Google)
```

## Local setup

```bash
cd brain
npm install
cp .env.example .env.local     # fill in values (see comments in the file)
npm run dev                    # http://localhost:3000
npm run typecheck && npm test && npm run build
```

Get a pairing code and pair a device by hand:
```bash
curl -s -X POST localhost:3000/api/devices/pair-code -H "Authorization: Bearer $OWNER_SECRET"
curl -s -X POST localhost:3000/api/devices/pair -H 'content-type: application/json' \
  -d '{"code":"123456","device":"phone","name":"Pixel"}'
curl -s -X POST localhost:3000/api/ask -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"What am I waiting on?","device":"phone"}'
```

## Deploy (Vercel)

1. **Upstash**: create a Redis database (or add the Upstash integration in Vercel). Copy the REST URL and token.
2. **Google Cloud**: create a project and enable the **Gmail API**, **Google Calendar API**, **Google Drive API** and **People API**.
   Configure the OAuth consent screen (External, add yourself as a test user, or publish). Create an OAuth client of
   type *Web application* with redirect URI `https://<your-domain>/api/google/callback` (plus
   `http://localhost:3000/api/google/callback` for dev). Scopes requested: `gmail.readonly`, `gmail.compose`,
   `calendar.readonly`, `drive.readonly`, `contacts.readonly`, `contacts.other.readonly`, `openid email`.
   An account connected before the contacts scopes were added must reconnect once to grant them.
   Note: while the app is in "Testing" status, Google expires refresh tokens after 7 days. Publish the app for a
   long-lived connection.
3. **Firebase**: in the Firebase project used by the Android apps, generate a service-account key and paste the JSON
   (or its base64) into `FIREBASE_SERVICE_ACCOUNT_JSON`.
4. **Vercel**: import the repo with **Root Directory = `brain`**. Set every variable from `.env.example` (at minimum:
   `ANTHROPIC_API_KEY`, `OWNER_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `APP_URL`, an STT key, and
   `FIREBASE_SERVICE_ACCOUNT_JSON`). Deploy.
5. **Connect Google**: `curl -s -X POST https://<your-domain>/api/google/connect -H "Authorization: Bearer $OWNER_SECRET"`
   returns a one-time `url`; open it in a browser within 5 minutes and approve. (Never put the owner secret in a URL.)
6. **Cron**: `vercel.json` schedules `/api/cron/scan` every 30 minutes. Sub-daily crons require a Vercel Pro plan
   (Hobby allows daily only). The scan route sets `maxDuration = 300`.
7. Pair devices as described above.

## Testing

`npx vitest run` runs entirely offline: Redis is an in-memory fake with TTL/NX semantics, Claude is a scripted fake,
Google Workspace and the mail sender are spies, and STT uses mocked `fetch`. Coverage includes auth and pairing, every
repo, extraction parsing, the spoken-length guard, the ask tool loop, cron scan idempotency and retries, briefs/Top-5
and the no-send invariant (static source scan plus behavioral checks).
