# SideKiqq QA Report

Independent review of `/brain` and the contract surface of `/android/shared`, plus the approval flows in `/android/phone` and `/android/watch`. `/medallion` firmware and Android compilation were out of scope.

**Result:** `npx tsc --noEmit` is clean. `npx vitest run` passes 131 of 131 tests: the original 120, plus 11 new tests in `brain/test/qa.test.ts`.

## Safety summary (send paths)

The no-send invariant holds.

- Only `brain/src/lib/connectors/google/send.ts` calls `gmail.users.drafts.send` (moved from `lib/google/sender.ts` on 2026-10-23), and only `brain/src/app/api/drafts/[id]/approve/route.ts` reaches it, through the sender registry `deps.senders()`. A static source scan in `test/no-send.test.ts` enforces this.
- None of the 12 Claude tools in `brain/src/lib/assistant/tools.ts` can send. `create_email_draft` only calls `Workspace.createDraft`, and the `Workspace` interface has no send method. If the model names an unknown tool such as `send_email`, it gets an error result.
- The approve route requires a device token and a draft that is still `pending`. A per-draft NX lock stops a double-tap from sending twice, the status is re-checked under the lock, and a Gmail draft that no longer exists returns 410.

Every device requires explicit confirmation before calling approve:

- **Watch:** tap Approve, then tap "Send to X?" (the `ApproveFlow` reducer).
- **Phone:** a confirm dialog (`ApproveDraftDialog`). Push notifications carry no send action.
- **Glasses and medallion:** `DraftConfirmation` accepts only the exact phrase "send it", within 30 s, one shot. Silence, an empty transcript or any other phrase cancels.

## Findings (ranked by severity)

### HIGH

**H1. The Gmail scan silently dropped mail.** Status: **fixed**.
- **Where:** `brain/src/lib/scan/scanner.ts:146`
- **Failure:** the scan listed only `SCAN_MAX_MESSAGES` (20) ids, and Gmail returns the newest first. It then advanced the cursor. If more than 20 messages arrived within 30 minutes, the older ones were never analysed, so their commitments and follow-ups were lost.
- **Fix:** the scan now lists up to 5× the limit, filters out already-processed ids, works through them oldest first, and holds the cursor while a backlog remains. The run result now includes `backlog`.
- **Test:** `qa.test.ts` › scan backlog.

**H2. FCM pushes did not reach the watch or medallion while the phone app was in the background.** Status: **fixed**.
- **Where:** `brain/src/lib/push/index.ts:84` (`buildMulticast`)
- **Failure:** the message carried a `notification` block. With that block, Android shows the tray notification itself and skips `onMessageReceived`. As a result, `WearRelay.sendAlert` and `MedallionService.signalNeedsAttention` never ran. The channel id `sidekiqq_alerts` also does not exist in the app, whose channel is `alerts`.
- **Fix:** messages are now data-only, keeping Android priority. The phone already builds the notification from `data.title` and `data.body`.
- **Test:** `qa.test.ts` › FCM payload.

**H3. `messaging/invalid-argument` was treated as an invalid token.** Status: **fixed**.
- **Where:** `brain/src/lib/push/index.ts:34`
- **Failure:** FCM also returns this code for payload problems such as oversize data. One bad alert would therefore have cleared the FCM token of every device.
- **Fix:** the code was removed from the invalid-token set.
- **Test:** `qa.test.ts` › FCM payload.

**H4. Due dates were interpreted in server UTC instead of America/Denver.** Status: **fixed**.
- **Where:**
  - `brain/src/lib/repos/commitments.ts:67,110`
  - `brain/src/lib/scan/extract.ts` (`normalizeDue`)
  - `brain/src/lib/assistant/tools.ts:89-90`
  - `brain/src/lib/util.ts` (`normalizeOwnerDate`)
- **Failure:** a voice commitment "due 2026-10-23" was stored as UTC midnight. That is 6 pm on Oct 22 in Denver, so the commitment was flagged overdue, and the owner alerted, a day early. Zone-less datetimes such as `17:00` were read as UTC, which is 11 am in Denver. Calendar lookups for a date-only day started at 6 pm the previous evening.
- **Fix:** date-only values now mean 23:59 owner-local for due dates, or 00:00 for calendar start dates. Zone-less datetimes are read as owner-local time. Both are DST-aware.
- **Tests:** `qa.test.ts` › owner time zone. `extract.test.ts` was updated to the new semantics.

### MEDIUM

**M1. The owner secret was accepted in the URL (`/api/google/connect?secret=`).** Status: **fixed**.
- **Where:** `brain/src/app/api/google/connect/route.ts:41`
- **Failure:** the secret was written to Vercel request logs, browser history and any proxy logs.
- **Fix:** `POST /api/google/connect` (owner header) now returns a single-use link with a 5-minute `?ticket=`. GET with `?secret=` is refused with 400. README step 5 was updated.
- **Action:** rotate `OWNER_SECRET` if the old link was ever used.

**M2. `/api/ask` time limits do not fit together.** Status: **open**.
- **Where:** `brain/src/app/api/ask/route.ts:8`, `brain/src/lib/assistant/llm.ts:18`
- **Failure:** `maxDuration` is 60 s. Meanwhile the Anthropic client allows a 90 s timeout with 2 retries, and the loop can run up to 8 model calls. A multi-tool question can hit Vercel's 504. When that happens, the conversation turn is lost and the Kotlin client, which waits 90 s, gets an HTML error.
- **Recommendation:** with Fluid compute, raise `maxDuration` to 120–300 s and lower the SDK timeout to 45 s.

**M3. Device tokens cannot be revoked or listed through the API.** Status: **open**.
- **Where:** `brain/src/lib/repos/devices.ts:80`
- **Failure:** `revoke()` exists, but no route calls it. A lost watch or phone keeps a permanent token that can approve drafts, and the only remedy is editing Redis by hand.
- **Recommendation:** add owner-only `GET /api/devices` and `POST /api/devices/:id/revoke`.

**M4. Collections grow without bound and are read in full on every call.** Status: **open**.
- **Where:** `brain/src/lib/repos/collection.ts:34`
- **Failure:** every scanned email adds a timeline row, and each read runs `HGETALL` over the whole hash. Drafts and resolved follow-ups are never pruned. Over months, latency and Upstash bandwidth grow, and the 1 MB request limit on the free tier can be reached.
- **Recommendation:** prune or archive old timeline, sent and resolved rows, or move timeline to a sorted set.

**M5. Email commitment dedup is per message, not per thread.** Status: **open**.
- **Where:** `brain/src/lib/repos/commitments.ts:47`
- **Failure:** the fingerprint includes the Gmail message id. The same promise quoted in a later reply on the thread becomes a duplicate commitment.
- **Recommendation:** fingerprint email commitments by `threadId` plus a normalized `who`/`what`.

**M6. Voice confirmation reads only the draft's recipient and subject.** Status: **open, design**.
- **Where:** `android/phone/.../assistant/DraftConfirmation.kt:53`
- **Failure:** on glasses and medallion, the owner confirms "send it" without hearing the body. A prompt-injected email could lead the model to draft a misleading body to a familiar recipient. The recipient is spoken, so this is limited.
- **Recommendation:** speak the first sentence of the body.

### LOW

**L1. A completed voice commitment blocked re-adding the same commitment.** Status: **fixed**.
- **Where:** `brain/src/lib/repos/commitments.ts:62`
- **Failure:** dedup on who and what with no ref matched completed rows, so a recurring "call Dana" was silently dropped.
- **Fix:** ref-less commitments now dedup only against open ones.

**L2. Follow-up upsert compared client names exactly.** Status: **fixed**.
- **Where:** `brain/src/lib/repos/followups.ts:34`
- **Failure:** "ACME Corp" and "acme corp " created duplicate open follow-ups.
- **Fix:** names are now compared with `slugify`.

**L3. The overdue-alert "once per day" key used the UTC date.** Status: **fixed**.
- **Where:** `brain/src/lib/scan/scanner.ts:201`
- **Failure:** the day rolled over at 5–6 pm Denver time.
- **Fix:** the key now uses the owner-local day.

**L4. The watch cannot approve drafts created by `/api/ask`.** Status: **open, functional gap; not a safety issue**.
- **Where:** `android/watch/.../ui/ask/AskScreen.kt:133-135`
- **Failure:** the "Review & approve" chip opens Follow-ups. Only follow-ups with a `draftId` are approvable there, and an ad-hoc draft from `/api/ask` has none.
- **Recommendation:** use `GET /api/drafts` on the watch.

**L5. The scan lock can be deleted by an overlapping run.** Status: **open**.
- **Where:** `brain/src/app/api/cron/scan/route.ts:31`
- **Failure:** if a run outlives the 280 s lock, a second run takes the lock, and the first run's `finally` then deletes it. The cursor and dedup markers keep this from causing harm.

**L6. The Google callback does not verify granted scopes.** Status: **open**.
- **Where:** `brain/src/app/api/google/callback/route.ts:52`
- **Failure:** if the owner unticks Gmail compose on the consent screen, the connection still "succeeds", and drafting fails later.

**L7. The pairing brute-force limit is per IP only.** Status: **open, acceptable**.
- **Where:** `brain/src/app/api/devices/pair/route.ts:15`
- **Detail:** 10 tries per 15 minutes per IP, against a 6-digit code that lives 10 minutes. The chance of a hit per IP per code is about 1e-5. A global cap would stop a botnet but would also let an attacker block pairing.

**L8. The contract table omitted the pairing, owner and push payload shapes.** Status: **fixed (docs)**.
- **Where:** `ARCHITECTURE.md`
- **Detail:** the Kotlin `PairRequest`/`PairResponse` were marked "ASSUMPTION". They match the server; the table now documents them.

## Contract check (brain ↔ Kotlin)

The Kotlin side matches the server for:

- `AskRequest` and `AskResponse`, `Commitment` (status enum values), `FollowUp`, `TopItem`, `Action`, `Brief`/`BriefKind`, `Top5Response`, `ItemsResponse`, `TranscribeResponse` and `RegisterDeviceRequest`.
- Server responses pass through zod contract schemas, which strip internal fields. Kotlin uses `ignoreUnknownKeys`.
- Optional fields are nullable with defaults. `dueInferred` is always sent.

No Kotlin changes were needed.

## Deploy readiness checklist

- [ ] **Env vars (Vercel):**
  - `ANTHROPIC_API_KEY`
  - `OWNER_SECRET` (≥16 chars; rotate if `?secret=` was ever used)
  - `TOKEN_ENCRYPTION_KEY` (32 bytes; `openssl rand -base64 32`)
  - `CRON_SECRET`
  - `APP_URL` (production URL; used for the OAuth redirect and connect links)
  - `OWNER_TIMEZONE=America/Denver`
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_EMAIL` (recommended)
  - Speech-to-text: `OPENAI_API_KEY` or `DEEPGRAM_API_KEY` with `TRANSCRIBE_PROVIDER`
  - `FIREBASE_SERVICE_ACCOUNT_JSON`
- [ ] **Google Cloud OAuth:**
  - Use a Web client.
  - Set the redirect URI to exactly `${APP_URL}/api/google/callback`.
  - Enable the Gmail, Calendar, Drive and People APIs.
  - Consent screen scopes: `gmail.readonly`, `gmail.compose`, `calendar.readonly`, `drive.readonly`, `contacts.readonly`, `contacts.other.readonly`, `openid` and `email`.
  - Publish the app out of "Testing", or refresh tokens expire after 7 days.
  - Connect with `POST /api/google/connect` and open the returned link.
- [ ] **Upstash:**
  - Create a Redis database (REST).
  - Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, or the `KV_REST_API_*` vars from the Vercel integration.
  - Watch storage growth (M4).
- [ ] **FCM:**
  - Use the same Firebase project as the Android apps' `google-services.json`.
  - Generate a service-account key and put it into `FIREBASE_SERVICE_ACCOUNT_JSON`.
  - Payloads are now data-only (H2).
- [ ] **Vercel cron and limits:**
  - The `*/30 * * * *` schedule needs a **Pro** plan. Hobby allows only daily crons, and the deploy fails.
  - `maxDuration = 300` on the scan needs Pro or Fluid compute.
  - Revisit `/api/ask` `maxDuration` (M2).
  - Set Root Directory to `brain`.
- [ ] **Pair devices:** `POST /api/devices/pair-code` (owner) → `POST /api/devices/pair` from the phone → `POST /api/devices/register` with the FCM token.
