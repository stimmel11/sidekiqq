# SideKiqq on Apple devices

**Status (2026-10-22):** the shared Swift package (`apple/SideKiqqKit`) and the first iPhone app (`apple/SideKiqq`) are written. Neither has been compiled on a Mac yet. The cloud crew can't run Xcode, so the first build, signing and TestFlight need Stimmel (see [What a human has to do](#what-a-human-has-to-do)).

Apple devices are thin clients, exactly like the Android ones. They use the same brain, the same API contract ([`ARCHITECTURE.md`](../ARCHITECTURE.md)) and the same safety rule. **Nothing is ever sent without explicit confirmation**, and `POST /api/drafts/:id/approve` is the only send path.

## Targets, in order

| # | Target | What it does | Status |
|---|---|---|---|
| 1 | **iPhone** (`apple/SideKiqq`) | Pairing, Today (Top 5 + brief), Follow-ups, Commitments, Drafts with a confirm sheet, a Talk button (voice loop), the medallion over CoreBluetooth, alerts | Written, not compiled |
| 2 | **Apple Watch** | Top 5, follow-ups, dictate a question, approve drafts with two taps, complications / Smart Stack, a haptic for CRITICAL | Not started |
| 3 | **CarPlay** | Voice-first communication app: alerts read aloud, voice replies, drafts still need a spoken "send it", same driving rules as Android Auto | Not started (needs an entitlement) |
| 4 | **Mac menu bar** | Top 5, quick ask, drafts to approve, notifications | Not started (`SideKiqqKit` already supports macOS 14) |
| 5 | **Siri / App Intents** | "Ask SideKiqq…", "What's my brief", "Who do I need to follow up with" | Not started |

## Layout

```
apple/
  project.yml                 XcodeGen spec (no hand-written .xcodeproj)
  scripts/gen-theme.mjs       design/tokens.json -> SideKiqqTheme.swift (--check for CI)
  SideKiqqKit/                Swift package, iOS 17 / macOS 14 / watchOS 10; also builds on Linux
    Sources/SideKiqqKit/
      Models.swift            Codable mirrors of brain/src/lib/models.ts (camelCase JSON, ISO date strings)
      SideKiqqClient.swift    async/await URLSession client for every route + SideKiqqAPI protocol
      TokenStore.swift        TokenStore protocol, KeychainTokenStore (#if canImport(Security)), InMemoryTokenStore
      WavEncoder.swift        16 kHz mono PCM16 WAV, PCMBuffer, Float -> Int16
      MedallionProtocol.swift GATT UUIDs + CONTROL opcodes
      UtteranceAssembler.swift  port of the Kotlin assembler (same seq/gap/dup/late rules)
      DraftConfirmation.swift   "send it" within 30 s state machine + read-back text
      VoiceAssistant.swift      the voice loop as pure logic (actor) over SideKiqqAPI + VoiceOutput
    Tests/SideKiqqKitTests/   XCTest: models vs brain-shaped fixtures, client vs a mock URLProtocol, all pure logic
  SideKiqq/                   SwiftUI iPhone app
    Sources/App               @main, AppDelegate (launch-time BLE restore), AppModel
    Sources/Services          Audio (capture, routing, speaker), VoiceSession, MedallionManager, Alerts + PushRegistrar
    Sources/Views             Pairing, Today, Follow-ups, Commitments, Drafts, DraftConfirmSheet, Talk, Settings
    Sources/Theme             SideKiqqTheme.swift (generated)
    Resources                 Assets, PrivacyInfo.xcprivacy
```

`SideKiqqKit` mirrors `android/shared`, and the Kotlin client stays the reference. When the contract changes, update `ARCHITECTURE.md`, `brain/src/lib/models.ts`, the Kotlin models and `apple/SideKiqqKit/Sources/SideKiqqKit/Models.swift` together.

## How each Android feature maps to Apple APIs

| Android (`android/phone`, `android/shared`) | iPhone | Notes |
|---|---|---|
| `SideKiqqClient.kt` (Ktor) | `SideKiqqClient` (URLSession, async/await) | Same routes, same 90 s timeout. Drafts list/discard extension routes included. |
| `TokenStore.kt` (Keystore AES-GCM + prefs) | `KeychainTokenStore` | One generic-password item, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: readable after first unlock (so a background BLE relaunch works while locked), never restored to another phone (same "re-pair after restore" policy as Android). |
| `AudioCapture.kt` (AudioRecord 16 kHz) | `AVAudioEngine` input tap + `AVAudioConverter` to 16 kHz mono Int16 | The hardware runs at 44.1 or 48 kHz; the converter resamples. 60 s cap. |
| `SpeechInput.kt` | **Server transcribe** (`/api/transcribe`) today | Same path as every other device, so transcripts match. `SFSpeechRecognizer` (on-device, `requiresOnDeviceRecognition`) is a later option for instant local endpointing and recognizing "send it" offline. The permission string is already in `project.yml`. |
| `Speaker.kt` (TextToSpeech, USAGE_ASSISTANT) | `AVSpeechSynthesizer`, or `/api/speak` WAV in `AVAudioPlayer` (Settings toggle) | Falls back to on-device on any error, including 413 for long text. `speak` waits until playback ends, so the 30 s window starts after the read-back. |
| Audio routing to glasses/earbuds | `AVAudioSession` | Listening: `.playAndRecord` + `.allowBluetooth` (AirPods mic over HFP), `.allowBluetoothA2DP`, `.defaultToSpeaker`. Speaking: `.playback`, mode `.spokenAudio`, `.mixWithOthers` + `.duckOthers` (A2DP quality; mixable so iOS lets it start from the background). |
| `MedallionService.kt` (foreground service, BluetoothGatt) | `MedallionManager` (CoreBluetooth central) | Scans by service UUID (needed for background scanning), remembers the peripheral id, notifies on AUDIO/CONTROL/BATTERY, writes 0x10 / 0x11 / 0x12. **MTU:** iOS negotiates it and has no request API. The firmware asks for 247 and sizes packets to the negotiated MTU (`AudioFramer::packetSizeForMtu`), so nothing changes on the medallion. The app shows `maximumWriteValueLength` in Settings. |
| Foreground service keeps BLE alive | `bluetooth-central` background mode + **state restoration** (`CBCentralManagerOptionRestoreIdentifierKey`) | The central is created in `didFinishLaunching` when the medallion is enabled, so a relaunch for a BLE event restores it. After a drop the app calls `connect` again; iOS pending connects never time out. Utterances processed in the background get a `beginBackgroundTask` for extra time. |
| `UtteranceAssembler.kt` | `UtteranceAssembler` (SideKiqqKit) | Line-for-line port with the same tests. |
| `DraftConfirmation.kt` + `VoiceAssistant.kt` | `DraftConfirmation` + `VoiceAssistant` actor (SideKiqqKit) | Same rules. Two deliberate tightenings, described below. |
| Confirm dialog (Compose) | `DraftConfirmSheet` (SwiftUI) | Shows To, Cc, Subject and the full body. Send is a separate toolbar button; Cancel is the default. It's the only UI caller of `approveDraftConfirmed`. |
| FCM push (`SideKiqqMessagingService`) | **Interim:** `GET /api/alerts` polling (60 s in the foreground, `BGAppRefreshTask` in the background) + local `UNUserNotification`s. **Later:** APNs | HIGH/CRITICAL alerts buzz the medallion (0x12) like Android. FYI alerts make no notification. The first poll after pairing only stores the cursor (no flood of old alerts). Notifications never carry a send action. `PushRegistrar` is the seam: `LocalNotificationsOnly` today, `APNsPushRegistrar` is ready for later. |
| Wear Data Layer (watch relay) | WatchConnectivity (Apple Watch target, later) | Or the watch talks to the brain directly with its own token, like the Galaxy Watch's fallback. |
| Glasses (Jetpack Projected) | None. AirPods are the "glasses" audio route | Meta/other glasses that pair as Bluetooth headsets just work as an audio route. |
| Compose theme (`design/dist/kotlin`) | `SideKiqqTheme.swift`, generated by `apple/scripts/gen-theme.mjs` | Light/dark dynamic colors, importance colors + written labels, a type scale bound to Dynamic Type text styles. Brand fonts are used if their TTFs get bundled; system fonts are the fallback. |
| Android Auto (backlog) | CarPlay communication app | Needs the **CarPlay Communication** entitlement (request from Apple; approval isn't guaranteed). Same driving rules: voice only, no full email on screen, drafts need a spoken "send it". |
| Tile / complication (watch) | WidgetKit (Lock Screen + Home Screen widget for Top 5), watch complications | Widgets read a cached Top 5 written by the app into an App Group (`group.com.sidekiqq`), and the token is shared through a keychain access group (`KeychainTokenStore(accessGroup:)`). |
| (none) | **App Intents** / Siri / Shortcuts | `AskSideKiqqIntent(text)`, `GetBriefIntent`, `WhoToFollowUpIntent`. A draft created via Siri is **never** approved from the intent. It opens the app's confirm sheet (`openAppWhenRun`) or uses the spoken "send it" flow. No intent calls `approveDraft` directly. |

### Safety: how the iPhone keeps the rule

- **Screen:** `DraftConfirmSheet` lists the recipients, subject and full body, and only its Send button calls `AppModel.approveDraftConfirmed`. Follow-ups, Drafts and Talk all go through it.
- **Voice (Talk button and medallion):** `VoiceAssistant` speaks a read-back of the **recipient, subject and a one-sentence body summary**, *then* starts the 30 s window (`DraftConfirmation.arm`). Only the exact words "send it", after normalizing case, punctuation and spacing, confirm. Anything else, silence, or a timeout cancels, and the draft stays saved.
- **The read-back must have been heard.** `VoiceOutput.speak` returns whether the text played to the end. If the read-back was interrupted (barge-in, a phone call, or audio that couldn't start), the window never opens and the owner is told to review the draft in the app.
- **The answer must come after the read-back.** Each utterance carries its capture start time (`startedAt`: the Talk tap, or medallion CONTROL 0x01). Speech that began before the window opened, for example a "send it" spoken over the read-back or queued behind it, declines instead of confirming.
- **One turn at a time.** Tapping Talk while SideKiqq is speaking only stops the speech; it doesn't start a new recording.
- **The confirm sheet can't double-send.** Send is guarded while a send is in flight. After a failure the sheet re-checks the draft: if it's no longer pending (or can't be checked), Send stays disabled and the owner is told to check Sent mail. A voice send that times out says "I couldn't confirm it was sent" instead of "not sent".
- **Differences from Android, all stricter (the three above, plus these two).** None changes the contract.
  1. The read-back comes from the real draft (`GET /api/drafts`), not the action summary, which closes the QA open item "read a one-sentence summary of the body". If the draft can't be loaded, nothing is offered by voice and the owner is told to review it in the app.
  2. Typed text never confirms. A typed "send it" cancels the pending draft. A late "send it" (after 30 s) is answered with "the confirmation window closed" instead of being forwarded to `/api/ask`.
- Only the first draft in a reply can be confirmed by voice. Any others wait in the Drafts tab (Android parity).
- Tests: `DraftConfirmationTests` and `VoiceAssistantTests`. A send within the window approves exactly once. None of these ever call `approveDraft`: a decline, an expired window, silence, typed text, a late "send it", an unloadable draft, an interrupted read-back, or a "send it" spoken over the read-back.

## Pairing

1. On the dashboard, open **Devices** and generate a 6-digit code (`POST /api/devices/pair-code`).
2. On the iPhone, enter the brain address and the code. The app calls `POST /api/devices/pair` with `{ code, device: "phone", name: "iPhone" }` and stores `{ baseURL, token, deviceId, device }` in the Keychain.
3. To unpair, go to Settings and choose **Unpair**. This clears the Keychain item; revoke the old token on the dashboard once revocation exists (backlog).

**Device kind:** today's brain accepts only `watch | glasses | medallion | phone | reachy`, so the iPhone pairs as **`phone`** and works with the current brain unchanged. In code this is `DeviceKind.thisIPhone`; switch it to `"iphone"` when the brain item below lands. The medallion relay uses `device: "medallion"` for `/api/ask`, as on Android.

## What the brain needs (backlog, not built here)

These are brain items for `PROGRESS.md`. The iPhone works without them; they make it first-class.

1. **`iphone` device kind** (and later `apple_watch`, `mac`): add it to `DEVICE_KINDS` in `brain/src/lib/models.ts`, the Kotlin `Device` enum, `ARCHITECTURE.md`, and the dashboard's Devices labels ("approved on iphone" in the timeline). Then flip `DeviceKind.thisIPhone`. Keep accepting `phone` from already-paired iPhones.
2. **APNs delivery** alongside FCM, in `lib/push` (`deliverAlert`).
   - **Option A (simplest):** Firebase's APNs bridge. Upload the APNs auth key to Firebase, and the iPhone registers an FCM token through the Firebase iOS SDK. This adds the Firebase SDK to the app.
   - **Option B (no SDK, recommended):** direct APNs over HTTP/2 with a token-based `.p8` key. Env vars `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID=com.sidekiqq.ios` and `APNS_ENV=sandbox|production`. Sign an ES256 JWT, cache it for under 60 min, and POST to `api.push.apple.com/3/device/<token>`.
   - Store the token via the existing `POST /api/devices/register`. The field is named `fcmToken` in the contract, so either rename it to `pushToken`, or keep the name and add `"transport": "apns"`, with the device kind telling them apart.
   - Payload: `aps.alert {title, body}`, `aps.sound`, `interruption-level` (`time-sensitive` for CRITICAL, which needs that entitlement), `thread-id` = client, plus the same data keys as FCM.
   - Handle `410 Unregistered` by clearing the token.
   - Until this lands, the app polls `/api/alerts` (already in the brain).
3. Optional: `GET /api/drafts/:id`, so a single draft can be fetched for the read-back without listing all pending drafts.

## Minimum versions

- **iOS 17.0** (and watchOS 10, macOS 14 for the shared package). These versions give the `@Observable` macro, `AVAudioApplication`'s record-permission API, `ContentUnavailableView`, the two-argument `onChange`, and SwiftUI `.backgroundTask`. They cover essentially every iPhone that can run iOS 17 (XS / XR and later).
- **Swift 5.10+, Xcode 15.3+** (Swift 5 language mode). Swift 6 strict concurrency is a later cleanup.

## Building, App Store and TestFlight

1. Install Xcode 15.3 or later and XcodeGen (`brew install xcodegen`).
2. Run `cd apple && xcodegen generate && open SideKiqq.xcodeproj`.
3. Set **Signing & Capabilities**: choose the Team and keep the bundle id `com.sidekiqq.ios` (or change it in `project.yml`). Background Modes (Bluetooth LE accessories, Audio, Background fetch) come from `project.yml`.
4. Run on a real iPhone. The simulator has no Bluetooth and no reliable mic routing.
5. Package tests: `cd apple/SideKiqqKit && swift test` (macOS or Linux).
6. **TestFlight:**
   - In App Store Connect, create the app record (bundle id `com.sidekiqq.ios`, SKU `sidekiqq-ios`).
   - In Xcode, go to **Product › Archive › Distribute App › App Store Connect**.
   - Add yourself as an internal tester (no review is needed for internal testers).
   - External testers need a short Beta App Review.
7. **App Store review notes** (when it gets that far):
   - Explain that SideKiqq is a single-owner assistant that talks to the owner's own server.
   - Provide a demo brain and pairing code for the reviewer.
   - Explain the Bluetooth (medallion), background audio (spoken replies) and microphone (tap-to-talk) uses.
   - Export compliance: HTTPS only, `ITSAppUsesNonExemptEncryption = false`.
8. **Still needed before an App Store upload:** a 1024×1024 app icon (`Assets.xcassets/AppIcon`). Bundling the brand fonts (Space Grotesk, Inter, JetBrains Mono, all OFL) is optional; until then the system font is used.

## Privacy manifest and permission strings

`apple/SideKiqq/Resources/PrivacyInfo.xcprivacy`:

- **No tracking**, no tracking domains.
- **Collected data types:**
  - Audio Data (the owner's spoken requests, sent to their brain for transcription)
  - Emails or Text Messages (drafts and summaries shown or sent)
  - Other User Content (questions and replies)
  - All of these are linked to the owner, used for App Functionality only, and never used for tracking.
- **Required-reason API:** `UserDefaults` with reason `CA92.1` (the app's own settings: alert cursor, medallion id, toggles).

Permission strings (in `project.yml` → `Info.plist`):

| Key | Text (summary) |
|---|---|
| `NSMicrophoneUsageDescription` | Listens only after you tap Talk; the recording goes to your brain for transcription. |
| `NSSpeechRecognitionUsageDescription` | For on-device recognition of short replies like "send it". Reserved: the app doesn't request speech permission yet. Remove it before App Review if `SFSpeechRecognizer` still isn't used, since an unused purpose string can draw questions. |
| `NSBluetoothAlwaysUsageDescription` | Connects to your SideKiqq medallion, even with the phone in your pocket. |

Background modes: `bluetooth-central`, `audio` and `fetch`, plus `BGTaskSchedulerPermittedIdentifiers: com.sidekiqq.alerts.refresh`. ATS stays on; `NSAllowsLocalNetworking` is set only so a development brain on the LAN can be reached over `http://`.

## Verification status

- `SideKiqqKit` is written to compile on Linux too: `FoundationNetworking`, with Keychain code behind `#if canImport(Security)`. The build crew's cloud sandbox couldn't download a Swift toolchain (download.swift.org is blocked by its proxy and Ubuntu 24.04 has no `swiftlang` package), so **`swift build` / `swift test` have not been run yet**. Run them on a Mac first.
- The iPhone app has **not been compiled**: there's no Xcode in the sandbox. The riskiest unverified parts are:
  - `AVAudioConverter` streaming in the input tap
  - starting audio playback from the background when a medallion utterance arrives while the phone is locked
  - CoreBluetooth state restoration and background reconnects
  - `@MainActor` / `Sendable` warnings with newer SDKs

## What a human has to do

- [ ] A Mac with Xcode 15.3+; run `swift test` in `apple/SideKiqqKit`, then `xcodegen generate` and the first build on a real iPhone. Fix what breaks.
- [ ] Apple Developer Program membership ($99/yr): create the App ID `com.sidekiqq.ios` and the App Store Connect record, then upload to TestFlight.
- [ ] Later: an APNs auth key (.p8) for the brain; the Push Notifications capability; a CarPlay Communication entitlement request.
- [ ] Test the medallion with the iPhone: press-to-talk from the lock screen, reconnecting after walking out of range, and a reply on AirPods.
