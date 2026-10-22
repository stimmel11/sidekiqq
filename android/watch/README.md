# SideKiqq for Galaxy Watch (Wear OS 5)

A thin client for the SideKiqq brain: push-to-talk questions, glanceable Top 5, follow-ups with a
two-step approve, and commitments with swipe-to-complete. There is also a tile, a complication,
and a phone bridge for alerts and medallion replies.

minSdk 30 · compileSdk 36 · targetSdk 35 · Compose for Wear OS · standalone

## Surfaces
| Surface | What it shows | Code |
|---|---|---|
| Ask (home) | Big round **Ask SideKiqq** button. Hold to talk, or tap to latch and tap again to send. `spoken` shows in large type; scroll for the full `reply` and any actions. | `ui/ask/` |
| Top 5 | `/api/top5`, colored by importance, with due labels | `ui/top5/` |
| Follow-ups | `/api/followups`. Tap one to see the suggested message, then **Approve**, then **"Send to &lt;person&gt;?"**, then **Send**, which calls `approveDraft`. | `ui/followups/`, `logic/ApproveFlow.kt` |
| Commitments | Open and overdue, overdue first and in red. Inferred dates carry a "· inferred" suffix. Swipe left (or tap Done) to complete. | `ui/commitments/`, `logic/DueFormat.kt` |
| Medallion reply | The latest phone-relayed answer, with Read aloud | `ui/reply/` |
| Settings | Speak answers (TTS) toggle, pairing status, Sync from phone, Enter pairing code, Unpair | `ui/settings/` |
| Tile | Top 3 actions plus the overdue count. Tap opens Top 5. Refreshes every 30 min. | `tile/` |
| Complication | SHORT_TEXT: follow-up count ("F/U"). RANGED_VALUE: the same count on a 0–10 gauge. Tap opens Follow-ups. | `complication/` |

## Voice pipeline
`AudioRecord` (16 kHz mono PCM16, VOICE_RECOGNITION source, 60 s cap) produces PCM. `WavEncoder`
(via `audio/WavAdapter.kt`) wraps it as WAV, which goes to `transcribe()`, then
`ask(device = WATCH, conversationId)`. If RECORD_AUDIO is denied, the app falls back to the system
**RemoteInput** voice/keyboard screen, which owns its own mic.
TTS is off by default (Settings → Speak answers) and reads only `spoken`.

## Safety
- **Nothing sends without two explicit taps.** `ApproveFlow` is a pure reducer, and only
  `Confirming → Sending` sets `sendNow`. It is unit-tested, including double-tap and
  confirm-without-approve cases. Answer actions of type `draft_created` only navigate to
  Follow-ups.
- An inferred due date is never shown without the "inferred" marker.

## Connectivity and auth
- `com.google.android.wearable.standalone = true`. All API calls are direct HTTPS from the watch.
  On LTE/Wi-Fi they go straight out; when tethered, Wear OS proxies them through the phone over
  Bluetooth. There's no separate code path.
- The token and brain URL are stored in :shared `TokenStore` (Keystore AES-GCM). Sources:
  1. The phone publishes a DataItem at `/sidekiqq/config` (`WearProtocol.PATH_CONFIG`, keys `token`
     and `baseUrl`), delivered to `PhoneListenerService.onDataChanged`. The `/sidekiqq/token` named
     in the original brief is also accepted.
  2. On launch while unpaired, `TokenSync` reads an existing DataItem.
  3. Standalone: Settings → Enter pairing code calls `SideKiqqClient.pair(code)`.
  Deleting the DataItem on the phone (`WearRelay.clearConfig`) unpairs the watch.
- `applicationId = "com.sidekiqq.app"` matches `:phone`. **The Data Layer only delivers between
  apps with the same applicationId and signing key**, so keep both in sync.

## Phone → watch Data Layer contract
Owned by :shared `com.sidekiqq.shared.wear.WearProtocol`, which the phone (`WearRelay`) and the
watch both use.
| Path | API | Payload | Watch behaviour |
|---|---|---|---|
| `/sidekiqq/config` | DataClient DataItem | `token`, `baseUrl` | store, then refresh the tile and complication |
| `/sidekiqq/alert` | MessageClient | `WearAlert{title, body, importance, kind?, followUpId?, draftId?}` | notification on the per-importance channel, plus the explicit CRITICAL haptic. Tap goes to Follow-ups (if followUpId/draftId or kind ~ follow/draft), Commitments (kind ~ commit/overdue) or Top 5 (kind ~ top/brief). |
| `/sidekiqq/reply` | MessageClient | `WearReply{text, spoken, conversationId?, source, actions}` | Reply screen (immediately if the app is in the foreground, otherwise via notification). The watch adopts `conversationId`, so the next watch question continues the thread. |

### Alert haptics (`logic/HapticPatterns.kt`)
| Importance | Pattern | Channel |
|---|---|---|
| CRITICAL | 3 × full-strength pulses (400/400/800 ms), played explicitly with ALARM usage, and also the channel pattern | `sidekiqq_critical_v1` (IMPORTANCE_HIGH) |
| HIGH | 2 × 250 ms | `sidekiqq_high_v1` |
| MEDIUM | 1 × 200 ms | `sidekiqq_normal_v1` |
| LOW / FYI | silent | `sidekiqq_low_v1` |

## Build and test
```
./gradlew :watch:assembleDebug -Psidekiqq.brainUrl=https://<your-brain>.vercel.app
./gradlew :watch:testDebugUnitTest
```
Unit tests (`src/test`) cover HapticPatterns, DueFormat, ApproveFlow, PushToTalk,
ComplicationMath, Payloads (WearAlert routing / WearReply mapping) and the GlanceSnapshot round trip.
The pure-logic tests (ApproveFlow, DueFormat, HapticPatterns) were compiled and passed in the
sandbox with Kotlin 2.0.21 against stub enums. Nothing that touches Android or :shared
serialization has been compiled, because Google Maven is blocked there. See the TODOs below.

## Open TODOs / unverified APIs
- Rotary scrolling relies on wear-compose-foundation ≥ 1.3 ScalingLazyColumn defaults (1.5.1 is pinned).
- Tile click extras (`AndroidActivity.addKeyToExtraMapping`) delivering `EXTRA_ROUTE`.
- `DataClient.getDataItems(uri)` with a host-less `wear:` URI (TokenSync).
- Background CRITICAL vibration on Galaxy Watch with the screen off (Haptics).
- `tile_preview.xml` is a placeholder vector. Replace it with a PNG screenshot.
- Commitments swipe is a custom drag gesture, not wear-compose SwipeToReveal (whose experimental
  API changed between 1.4 and 1.5). It exposes a "Complete" accessibility action.
