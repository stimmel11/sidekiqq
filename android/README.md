# SideKiqq Android

This Gradle project has three modules:

| Module | What it is |
|---|---|
| `:shared` | Kotlin API client (`SideKiqqClient`), models, `TokenStore`, `WavEncoder`, and the phone/watch Data Layer contract (`WearProtocol`) |
| `:phone` | Phone companion app (Compose / Material 3). It relays the medallion over BLE, hosts the Galaxy Glasses experience, receives FCM push, and forwards to the watch |
| `:watch` | Wear OS app for Galaxy Watch. See `watch/README.md` |

The binding contracts are in `../ARCHITECTURE.md`: the Brain API and the medallion GATT protocol.

## Requirements
- Android Studio Narwhal or newer. To use the AI Glasses emulator you need the **latest Canary**, because the XR tools ship there first.
- JDK 17+. The JBR bundled with Studio works.
- AGP 8.13, Kotlin 2.2, Gradle 8.14.3. The Gradle wrapper (`gradlew`, `gradle/wrapper/gradle-wrapper.jar`) is committed.
- **Build status:** this project has not yet been compiled end to end with AGP. The sandbox it was written in cannot reach Google Maven or dl.google.com. The pure-JVM logic and its tests were compiled and run with Kotlin 2.0.21. The first real `./gradlew build` may still surface API mismatches, most likely in the alpha XR code (see below).
- Phone: Android 11 (API 30) or newer. Glasses projection needs Android 16 (API 36) on the phone. On older phones the glasses fall back to plain Bluetooth-headset mode.

## Open and run
1. In Android Studio, choose **File → Open** and select the `android/` folder. Let Gradle sync.
2. Pick the `phone` run configuration and run it on a device or emulator.
3. **Set the server URL and pair.** On first launch the app shows the pairing screen.
   - **Server URL:** your brain deployment, e.g. `https://sidekiqq.vercel.app`. For a local `next dev` reached from the emulator, use `http://10.0.2.2:3000`. Cleartext is allowed only for `10.0.2.2`, `localhost` and `127.0.0.1`; see `res/xml/network_security_config.xml`.
   - **Pairing code:** the 6-digit one-time code from the brain. The app calls `POST /api/devices/pair` and stores the long-lived device token. The token is encrypted with an Android Keystore AES-GCM key.
   - After pairing, the phone:
     - registers its FCM token (`/api/devices/register`, device `phone`)
     - pushes `baseUrl` and `token` to the watch as DataItem `/sidekiqq/config`, so the watch needs no separate pairing
4. Grant notifications, microphone and nearby-devices (Bluetooth) when prompted.

## Firebase (push alerts)
`google-services.json` is **not committed**; it is listed in `.gitignore`.
1. In the Firebase console, create or choose a project and add an Android app with package **`com.sidekiqq.app`**.
2. Download `google-services.json` to `android/phone/google-services.json`.
3. Sync. The Google Services plugin is applied only when that file exists. Without it the app still builds and runs, but has no push.
4. On the brain side, set the Firebase Admin service-account credentials.

The brain's `/api/cron/scan` sends a data message with the keys `title`, `body`, `importance` (CRITICAL|HIGH|MEDIUM|LOW|FYI), `kind`, and optionally `followUpId` and `draftId`. For each message, the phone:
- shows a notification (FYI is skipped)
- forwards it to the watch on MessageClient path `/sidekiqq/alert`
- for HIGH and CRITICAL only, writes CONTROL `0x12` (double haptic) to the medallion

## Safety: nothing is sent without explicit confirmation
`SideKiqqClient.approveDraft()` is the only call that sends anything. It is reachable only from:
- **Phone:** the "Send" button in `ApproveDraftDialog`, which shows the recipient and message. Cancelling or dismissing does nothing.
- **Glasses and medallion voice:** after the brain creates a draft, SideKiqq says *"Send this: …? Say 'send it' to confirm."* and listens once more.
  - Only an exact "send it" approves the draft, and only within 30 s.
  - "Don't send it", "yes", "sure" and silence all leave the draft unsent.
  - The rule is implemented in `assistant/DraftConfirmation.kt` and unit-tested.

Notifications never carry a "send" action.

## Medallion relay
Tap **Connect medallion** on the Home tab to start `MedallionService`, a foreground service of type connectedDevice. It uses plain `BluetoothGatt` (no Nordic library):
1. Scans for service `5a1d0001-…`, connects, requests MTU 247 and enables notifications on AUDIO, CONTROL and BATTERY.
2. CONTROL `0x01` starts an utterance. AUDIO packets (`[seq:uint8][PCM16 LE]`) are reassembled by `UtteranceAssembler`:
   - sequence numbers wrap at 255
   - duplicates are dropped
   - gaps of up to 8 packets are padded with silence and flagged
   - late packets are dropped and flagged
3. CONTROL `0x02` ends the utterance. If no audio arrives for 3 s, the utterance is finalized anyway.
4. The audio is converted to WAV and sent to `/api/transcribe`, then to `/api/ask` with `device=medallion`.
5. While the brain is thinking, the phone writes `0x10`.
6. The `spoken` reply plays as TTS on the active audio route (glasses or earbuds over A2DP).
7. The phone writes `0x11`, and the reply text goes to the watch on `/sidekiqq/reply`.

The service reconnects with exponential backoff.

## Galaxy Glasses
Everything XR-specific is behind `glasses/GlassesBridge`. The code that imports `androidx.xr` is in the `phone/src/xr` source set (`ProjectedGlassesBridge`, `ProjectedSupport`). `phone/src/noxr` has a stub `ProjectedSupport` with the same API.
- By default (`sidekiqq.xr=true`) the XR source set and the `androidx.xr.projected` dependency are included.
- If the alpha artifact fails to resolve or compile, build with `./gradlew assembleDebug -Psidekiqq.xr=false`, or set `sidekiqq.xr=false` in `gradle.properties`. Glasses then use only the Bluetooth-headset bridge, and "Open on glasses" returns false.

The two bridges:
- **`ProjectedGlassesBridge`** (Android 16+) uses `androidx.xr.projected:projected:1.0.0-alpha13`:
  - `ProjectedContext.isProjectedDeviceConnected` for connect and disconnect
  - `createProjectedDeviceContext` for glasses audio
  - the glasses mic over HFP/SCO with `VOICE_COMMUNICATION`, as in Google's projected-context guide
- **`BluetoothHeadsetGlassesBridge`** is the fallback. It treats the glasses as a BT headset: SCO mic in, TTS out.
- **`GlassesActivity`** is the projected entry point. It is declared with `requiredDisplayCategory=XR_PROJECTED` and the `XR_PROJECTED_LAUNCHER` category, and it runs on the glasses. A touchpad tap means **"Hey SideKiqq"**. On display glasses it also shows the current state and the last reply.
- **`GlassesSessionService`** is the phone-side voice loop (a microphone foreground service). For each turn it:
  1. plays an earcon
  2. listens through the glasses mic
  3. sends the audio to transcribe, then to ask with `device=glasses`
  4. speaks the reply on the glasses
  5. if a draft was created, runs the strict voice confirm

There is no always-on hotword. You wake SideKiqq explicitly: tap the glasses touchpad, press **Hey SideKiqq** on the phone, or use the notification action.

### Testing with the Android Studio AI Glasses emulator
1. Install the **latest Android Studio Canary**. In the SDK Manager, install the Android XR / AI Glasses system image, plus an Android 16 (API 36) phone image with Google Play.
2. In Device Manager, create two AVDs:
   - an **AI Glasses** AVD
   - a **phone** AVD on API 36 to act as its host
   Follow Google's "Create virtual devices for glasses" guide.
3. Start the **phone AVD first**, then the **glasses AVD**. The glasses pair to the phone through the Glasses app.
4. Select the **phone AVD** as the run target and run `phone`. Pair the app with your brain URL. Use `http://10.0.2.2:3000` for a local brain.
5. On the Home tab, tap **Open on glasses**. This launches `GlassesActivity` via `ProjectedContext.createProjectedActivityOptions`. You can also open SideKiqq from the glasses launcher.
6. Click the glasses emulator's **touchpad** (below the display) to wake SideKiqq. Speak through your computer mic, which routes to the emulator's mic.
   - A long press of about 2 s is reserved for Gemini, so SideKiqq ignores long presses.
   - To test audio-only glasses: open the Glasses app on the phone emulator and go to **Device Settings → Audio-only mode**. Then **cold boot** the phone AVD. You must do this every time you toggle the mode.
7. Draft-confirm test: ask *"Draft a reply to Dana saying I'll send pricing Friday."* SideKiqq creates the draft and asks you to confirm.
   - Say anything other than "send it". The draft stays unsent.
   - Repeat and say "send it". The phone calls `/api/drafts/:id/approve`.

## Tests
```
./gradlew :shared:test :phone:testDebugUnitTest :watch:testDebugUnitTest
```
- `:shared` covers `WavEncoder`, JSON (de)serialization and `SideKiqqClient` against the Ktor MockEngine.
- `:phone` covers `UtteranceAssembler` (sequence wrap, gaps, duplicates and late packets) and `DraftConfirmation`.

## Phone ↔ watch contract (`com.sidekiqq.shared.wear.WearProtocol`)
| Path | Kind | Payload |
|---|---|---|
| `/sidekiqq/alert` | MessageClient | `WearAlert` JSON |
| `/sidekiqq/reply` | MessageClient | `WearReply` JSON |
| `/sidekiqq/config` | DataItem | keys `baseUrl` and `token` |

The phone and watch must share **applicationId `com.sidekiqq.app`** and the same signing key, or the Data Layer drops messages.

## Known assumptions
- `POST /api/devices/pair` takes `{"code","device"}` and returns `{"token","deviceId","device"}`. This was checked against `brain/src/app/api/devices/pair/route.ts`. The phone pairs as `phone` and the watch as `watch`.
- There is no `GET /api/drafts/:id`. The glasses therefore speak the draft's `Action.summary` in the confirm prompt.
