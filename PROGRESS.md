# SideKiqq — Build Progress & Backlog

This file is the build crew's memory. Every session (human or bot) reads it first and updates it last.

## Module status (as of 2026-10-22)

| Module | Status | Notes |
|---|---|---|
| Architecture & API contract | Done | `ARCHITECTURE.md` (binding). Pairing/connect/push shapes added by QA. |
| Brain backend (`/brain`) | Done, tested | Typecheck clean, 377 tests passing. Connector framework slices 1–2 (encrypted `ConnectionStore`), task layer slice 1 (`/api/commands`) and Google Contacts (`contacts.lookup` + `lookup_contact` tool) in place. Not yet deployed. Includes `GET /api/alerts` and `POST /api/speak` for Reachy. |
| Phone companion + Galaxy Glasses (`/android/phone`) | Written, statically fixed | Never compiled. Cloud sandbox can't reach Google Maven. Glasses XR is optional (`-Psidekiqq.xr=false`). |
| Galaxy Watch (`/android/watch`) | Written, statically fixed | Never compiled (same reason). |
| Shared Kotlin client (`/android/shared`) | Written | 42 pure-JVM tests passing. |
| Medallion firmware + hardware guide (`/medallion`) | Done, untested on hardware | Compiles and links for ESP32-S3; 31 native tests pass. See `medallion/HARDWARE.md`. |
| Reachy Mini app (`/reachy`) | Written, tested off-robot | Python `sidekiqq_reachy` ReachyMiniApp (HF Space). 88 pytest tests pass, including integration against the real reachy-mini 1.12.0 SDK classes with a fake robot. `reachy-mini-app-assistant check` passes its structure checks; its venv install step can't run here (PyGObject). Never run on hardware. |
| Marketing site (`/site`) | Built, not deployed | Astro 7 + Tailwind, static. Home, /devices, /privacy-and-trust, /blog, 404. Copy in `site/src/content/`; see `site/EDITING.md`. |
| UI framework (`/design` + owner dashboard `brain/src/app/(dashboard)`) | Done, tested | Tokens → CSS vars, Tailwind preset, Compose theme (`design/build.mjs`). Dashboard: login (SESSION_SECRET cookie), Today, Follow-ups, Drafts (approve via the existing approve route), Commitments, Devices. Compose theme not compiled yet. |
| Apple (`/apple`) | Written, not compiled | `SideKiqqKit` Swift package (client, models, Keychain token store, WAV, medallion protocol + assembler, `DraftConfirmation`, voice loop) with XCTest suites, and the SwiftUI iPhone app (XcodeGen). No Swift toolchain or Xcode in the sandbox, so `swift test` and the app build have not run yet. iPhone pairs as `phone`; alerts via `/api/alerts` polling until APNs. See `docs/APPLE.md`. |
| QA review | Round 1 done | `QA_REPORT.md`. 8 issues fixed, 6 open (below). |

## History
- 2026-10-16: First session wrote the architecture, brain, and Android apps. Never committed.
- 2026-10-21: Work recovered and pushed. Build crew round 1: Android static fixes, QA review + fixes, medallion firmware.
- 2026-10-21: Reachy Mini added as the fifth device (`crew/reachy-mini`): device kind `reachy`, alert log + `GET /api/alerts`, `POST /api/speak` (OpenAI TTS), and the `/reachy` app.
- 2026-10-21: Marketing site built in `/site` (branch `crew/marketing-site`): Astro + Tailwind, schema-checked content, waitlist with mailto fallback.
- 2026-10-21: UI framework: `/design` tokens + generator (CSS, Tailwind preset, Compose theme), owner web dashboard in the brain with signed-session login. Tagline changed to "SideKiqq, it goes where you go."
- 2026-10-22: Connectors design written (`docs/CONNECTORS.md`, branch `crew/connectors-design`): capabilities, brain as MCP client, per-connector encrypted OAuth with minimal scopes, auto/confirm/user-finishes policy; confirm actions become Drafts so approve stays the only executor.
- 2026-10-22: Apple support started (`crew/apple-ios`): `docs/APPLE.md`, the `apple/SideKiqqKit` Swift package with tests, and the SwiftUI iPhone app (pairing, Today, Follow-ups, Commitments, Drafts confirm sheet, Talk voice loop, CoreBluetooth medallion with state restoration, alert polling). The voice read-back now includes recipient, subject and a one-sentence body summary. Not compiled yet (no toolchain in the sandbox).
- 2026-10-23: Connector framework slice 1 (`crew/connector-framework`): capability layer + fixed policy + audit log, Google wrapped as a connector, sender registry; tools/scan/brief go through `invokeCapability`. 242 brain tests.
- 2026-10-24: Task layer slice 1 (`crew/device-commands`): per-device command queue `POST/GET /api/commands` + ack (open_url / call_contact / reachy_wake hand-offs, tap-to-act only), contract + Kotlin client.
- 2026-10-27: Task layer slice 2a (`crew/phone-handoffs`): phone polls device commands and shows tap-to-act hand-offs (dialer/WhatsApp/browser) with acks. Android unverified; 9 handoff JVM tests pass via kotlinc.
- 2026-10-25: Google Contacts slice 1 (`crew/google-contacts`): People API `contacts.lookup` module + read-only contacts scopes; framework wiring is slice 2.
- 2026-10-26: Connector framework slice 2 (`crew/connection-store`): encrypted per-connector `ConnectionStore` with key rotation, Google token migration, PKCE, enabled capabilities and `needs_reauth` checked in `invokeCapability`. 345 brain tests.
- 2026-10-28: Google Contacts slice 2 (`crew/contacts-capability`): `contacts.lookup` registered on the `google` connector (audited, background-readable), Claude tool `lookup_contact` (ambiguity → ask, never guess an address), wired in `deps`. 332 brain tests.
- 2026-10-29: Task layer slice 4a (`crew/command-nudge`): silent FCM command nudge to the target device + phone handling (poll now / generic "hand-off waiting" notification). 377 brain tests; Android unverified.

## Backlog (top = next)

Bots take the first unchecked item that is NOT tagged `[needs-human]`.

### Next up: connectors + tasks (owner priority, 2026-10-21)
SideKiqq should connect to any email, video and grocery service, and run tasks started from any device.
- [x] Design `docs/CONNECTORS.md`: capability interfaces (`email.send`, `email.read`, `contacts.lookup`, `video.start`, `grocery.cart`, `calendar.*`), the brain as an MCP client, per-connector OAuth with encrypted token storage and minimal scopes, and a per-capability safety policy enforced by the brain (auto / confirm / user-finishes). No connector can bypass draft approval.
- [ ] Brain: implement the connector framework from that doc + a "Connections" screen in the dashboard. Move Gmail/Calendar/Drive onto it.
  - [x] Slice 1 (`crew/connector-framework`): capabilities + `POLICY`, `invokeCapability` (caller rules, audit log), `google` connector, sender registry (`lib/connectors/google/send.ts`), all Gmail/Calendar/Drive callers moved off `deps.workspace()`, no-send scan generalised.
  - [x] Slice 2 (`crew/connection-store`): `ConnectionStore` (AAD per connector, PKCE on Google OAuth, key rotation via `TOKEN_ENCRYPTION_KEY_PREV`), legacy Google token migration, per-connection enabled capabilities + granted-scope check + `needs_reauth` (set on `invalid_grant`) enforced in `invokeCapability`. Deferred to slice 4: the one owner alert on `needs_reauth` (needs a new alert kind in the contract), provider-side revoke on disconnect, incremental per-capability Google scopes, and deleting the legacy `google:tokens` key after one release.
  - [ ] Slice 3: Draft `kind`/`connectorId`/`readback` (code-built readback as `Action.summary`), `email.draft` creating the Draft record, `ARCHITECTURE.md` + TS + Kotlin `Draft` model, `GET /api/drafts` fields.
  - [ ] Slice 4: `/api/connections` routes + dashboard Connections screen; `search_email` tool rename with alias.
- [ ] Brain: task layer + device routing. Commands started on any device can run on another device (per-device command queue delivered via FCM or `/api/alerts`-style polling). Commands: `device.call_contact`, `reachy.wake`, `open_url`.
  - [x] Slice 1 (brain + contract): per-device queue, `POST/GET /api/commands`, `POST /api/commands/:id/ack`, kinds `open_url` / `call_contact` / `reachy_wake`, URL allowlist, number rules, 15-min expiry, Kotlin models + client (unverified). Delivery is polling only.
  - [x] Slice 2a (`crew/phone-handoffs`, unverified: Android not compiled): phone polls `GET /api/commands` on open and every 30 s while visible, shows a hand-off dialog (label + number/URL on its own line), opens only on tap (`ACTION_DIAL`, WhatsApp `wa.me`, browser), then acks; re-checks number/URL allowlist on the phone, re-sends lost acks, clears stale hand-offs when backgrounded or offline > 60 s, tap guard. Pure logic in `phone/handoff/HandoffPlan.kt` with JVM tests.
  - [ ] Slice 2b: Watch "call <name> on my phone" via `createCommand` (needs the number: wait for `contacts.lookup` slice 2, or a spoken number). Optional: persist handled ids across process death; percent-encode `{ } | ^` in query strings that `java.net.URI` rejects.
  - [ ] Slice 3: Reachy app polls `/api/commands` alongside `/api/alerts` and handles `reachy_wake` (chat/brief/dance/game).
  - [ ] Slice 4: FCM data nudge `kind: "command"` to the target device (phone must ignore it as a notification), and handoffs from `invokeCapability` (`user_finishes` tier, after the connector-framework PR lands).
    - [x] 4a (`crew/command-nudge`, Android unverified): brain sends a data-only `{kind:"command", commandId}` (no title/body, high priority, 3 s timeout, best effort) to the target device's own token after `POST /api/commands`; never logged as an alert. Phone polls at once if visible, else posts one generic "Hand-off waiting" notification (no content, open-app only); never relayed to the watch or medallion. `CommandNudge` JVM test written but not run (no kotlinc allowed this run).
    - [ ] 4b: hand-offs from `invokeCapability` (`user_finishes`). Any new path that queues a command (e.g. `call_on_phone` in PR #13) must also call `nudgeCommandTarget`. Follow-up: `setFcmToken` should clear the same token from other device records, so a stale phone record can't receive another phone's nudge.
- [x] Connector: Google Contacts (`contacts.lookup`), so "email this to <name>" resolves people.
  - [x] Slice 1: `brain/src/lib/google/contacts.ts` (People API lookup of saved + Other contacts, warm-up, name ranking, ambiguity returned, cleaned emails/phones) and the two read-only scopes. Tested with a fake People API.
  - [x] Slice 2 (connector framework is now on main): register it as `contacts.lookup` on the `google` connector, add the Claude tool `lookup_contact`, and wire it into `deps`. Done 2026-10-28 (`crew/contacts-capability`).
- [ ] Task: "email this <dictated paragraph> to <contact>": draft, read back, "send it".
- [ ] Connectors: Google Meet, Zoom (create meeting + send invite after confirm); phone-side call intents (WhatsApp, Samsung/phone video).
- [ ] Task: "start up Reachy and let's do something". The phone on the home LAN calls the Reachy daemon (`/api/apps/start-app/...`), and Reachy offers a dance/game/brief.
- [ ] Connector: Kroger / King Soopers (public API: product search, add to cart; NO checkout or pickup-slot API). Task: "here's my grocery list" fills the cart, then hands checkout to the phone. Never automate payment.
- [ ] Connectors: Outlook / Microsoft 365, generic IMAP/SMTP; investigate Instacart's developer platform terms for other grocery chains.
- [ ] "Request a connector" flow: the build crew generates an MCP connector, opens a PR, and the owner approves before it goes live.
- [ ] Android Auto: messaging-style alerts + voice reply via the phone app, plus a simple Car App Library screen (Top 5, Talk). Driving mode: voice only, no full email on screen, drafts still need a spoken "send it", screen-only tasks wait until parked.

### Apple support (owner request, 2026-10-21)
Same brain and API contract; Apple devices are thin clients like the Android ones. Swift/SwiftUI in a new `/apple` folder (one Xcode project, shared `SideKiqqKit` Swift package mirroring `android/shared`).
- [x] Design `docs/APPLE.md`: targets, shared Swift client + models generated or mirrored from `ARCHITECTURE.md`, pairing, push, which Android features map to which Apple APIs, and App Store / TestFlight path.
- [ ] Brain: `iphone` device kind (later `apple_watch`, `mac`) in `DEVICE_KINDS` (TS), the Kotlin `Device` enum and `ARCHITECTURE.md`; keep accepting `phone` from already-paired iPhones. Then switch `DeviceKind.thisIPhone` in `apple/SideKiqqKit` to `"iphone"`. See `docs/APPLE.md` › What the brain needs.
- [ ] Brain: APNs delivery alongside FCM in `lib/push` (`deliverAlert`). Recommended: direct APNs over HTTP/2 with a token-based `.p8` key (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID=com.sidekiqq.ios`, `APNS_ENV`). Register via `POST /api/devices/register` (decide `fcmToken` → `pushToken` or add `transport: "apns"`), clear tokens on 410, with tests. Then switch the iPhone from `LocalNotificationsOnly` to `APNsPushRegistrar`. Until then the iPhone polls `/api/alerts`.
- [ ] Brain (optional): `GET /api/drafts/:id` so devices can fetch one draft for the voice read-back instead of listing all pending drafts.
- [ ] `SideKiqqKit` Swift package: API client, models, Keychain token store, and unit tests (runs on macOS CI). **Partial (2026-10-22):** written with XCTest suites (models vs brain-shaped fixtures, client vs a mock URLProtocol, WAV, assembler, `DraftConfirmation`, voice loop); not yet run, since the sandbox can't download a Swift toolchain. Remaining: run `swift test` on a Mac or Linux with Swift 5.10+, fix what breaks, and add a CI job.
- [ ] iPhone app: pairing, Today/Top 5, follow-ups, commitments, drafts with confirm-to-send, push alerts, and the voice loop (record → `/api/transcribe` → `/api/ask` → spoken reply via AirPods or speaker). **Partial (2026-10-22):** all screens and the voice loop written in `apple/SideKiqq` (XcodeGen `project.yml`); alerts come from `/api/alerts` polling + local notifications until APNs exists. Never compiled. Remaining: first Xcode build on a real iPhone (`[needs-human]` item below), app icon.
- [ ] iPhone: medallion support over CoreBluetooth (same GATT protocol as the Android phone), including background BLE restoration. **Partial (2026-10-22):** `MedallionManager` written (scan by service UUID, notifications, reassembly, 0x10/0x11/0x12, state restoration, reconnect). Remaining: test with real hardware, especially press-to-talk from the lock screen and starting audio playback from the background.
- [ ] Siri + Shortcuts via App Intents: "Hey Siri, ask SideKiqq…", "…what's my brief", "…who do I need to follow up with". Drafts still need an explicit confirmation step.
- [ ] Apple Watch app: Top 5, follow-ups, dictate a question, approve drafts with two taps, complications and Smart Stack widget, haptic for CRITICAL alerts.
- [ ] CarPlay: communication-style experience with voice-first alerts and replies, plus the same driving-mode rules as Android Auto.
- [ ] Mac: menu-bar app (Top 5, quick ask, drafts to approve) and notifications.
- [ ] Connectors: iCloud Mail (IMAP/SMTP with an app-specific password), Apple Calendar (CalDAV), Apple Contacts (CardDAV), FaceTime call hand-off (`facetime://` from the iPhone app).
- [ ] Site: once Apple support ships (iPhone app in TestFlight or later), update the Questions section: rewrite `site/src/content/faq/04-phone.md` ("Does it work on iPhone?", currently "Not yet") and review the other FAQ answers (`03-devices.md`, `02-accounts.md` for iCloud). Also add iPhone / Apple Watch / CarPlay / Mac to `site/src/content/devices/` and the home page devices section. State only what has actually shipped. Do this in the same PR that marks the iPhone app as shipped, or right after it.
- [ ] `[needs-human]` Apple Developer Program membership, App Store Connect app record, APNs key, and a Mac with Xcode for the first builds and TestFlight. The cloud crew can write Swift but can't compile or sign iOS apps.

### Earlier items

- [ ] Brain: `/api/ask` can exceed its 60 s Vercel limit. Add a time budget around the Claude tool loop and return a partial `spoken` reply, with tests. (QA open item)
- [ ] Brain: add `POST /api/devices/:id/revoke` (owner secret) and `GET /api/devices` to revoke a lost device's token, with tests. (QA open item)
- [ ] Brain: bound Redis collections (cap + archive done commitments older than 90 days; paginate reads). (QA open item)
- [ ] Brain: the People API warm-up in `lib/google/contacts.ts` is fire-and-forget; on Vercel the un-awaited requests may be dropped when the function freezes, and the first lookup per 10 min searches a stale cache. Consider awaiting the warm-up (with a short timeout) on the first lookup, or warming from the cron scan.
- [ ] Brain: dedupe a commitment that is re-quoted in a later reply on the same thread. (QA open item)
- [ ] Phone/glasses: the voice "send it" confirmation should read a one-sentence summary of the draft body, not just recipient + subject. (QA open item)
- [ ] Watch: allow approving drafts created from `/api/ask` replies (currently only from follow-ups). (QA open item)
- [ ] Phone: adopt `design/dist/kotlin/SideKiqqTheme.kt` (move into `android/shared` or a new `android/shared-ui` module, wire fonts, wrap the root in `SideKiqqTheme`). See `design/README.md`.
- [ ] Watch: adopt the Compose theme via Wear `MaterialTheme` (always dark). See `design/README.md`.
- [x] Brain: `@upstash/redis` with `automaticDeserialization: false` returns HGETALL as a flat `[field, value, ...]` array, not an object, so `Collection.all()` sees numeric keys and logs "unparseable row" for every field name. Reads only work by accident. Fix in `lib/kv.ts` (convert pairs to an object) with a test against the real client's shape.
- [ ] Dashboard: revoke a device from the Devices screen once `POST /api/devices/:id/revoke` lands.
- [ ] Dashboard: cache the generated brief (each Today visit calls Claude once; Top 5 is already cached for 1 h).
- [ ] Dashboard: server-side session revocation (logout currently clears the cookie; rotating SESSION_SECRET signs out everywhere).
- [ ] Dashboard: the dashboard approves as a paired device of kind `phone` named "Owner web dashboard" (timeline says "approved on phone"). Consider adding a `web` device kind to the contract.
- [ ] Brain: `next build` runs out of memory during type-checking at the default Node heap in a 7 GB sandbox (pre-existing, also on `build-crew-round-1`; likely the `googleapis` types). `NODE_OPTIONS=--max-old-space-size=6144` works. Check Vercel, consider `typescript.ignoreBuildErrors` with tsc in CI.
- [ ] CI: run `node design/build.mjs --check` so generated design outputs never drift.
- [ ] Medallion + phone: BLE bonding/encryption, so the phone pairs only to the owner's medallion.
- [ ] Brain: a `docs/DEPLOY.md` step-by-step for Vercel (Pro plan for 30-min cron), Upstash, Google Cloud OAuth consent, FCM, env vars.
- [ ] Phase 2 design: texts (Android SMS via the phone companion), Facebook groups (API limits; investigate options), Outlook. Write `docs/CHANNELS.md` with a recommendation before building.
- [ ] Reachy: settings page (port 8042) has no auth. Add an optional local PIN, or bind to localhost behind the dashboard.
- [ ] Reachy: train a custom "hey SideKiqq" openWakeWord model (the default is `hey_jarvis`) and test false-accept rates.
- [ ] Reachy: barge-in (stop TTS when the owner talks over it) and head wobble while speaking (`media.enable_wobbling`).
- [ ] `[needs-human]` Reachy: publish the Space (`hf auth login`, `reachy-mini-app-assistant publish ./reachy`), install from the dashboard and test on a real Reachy Mini. Tune the endpointing thresholds for the real mic, check the antenna/pitch directions of the poses, and check that `play_sound` timing doesn't clip replies. Set `OPENAI_API_KEY` on the brain for `/api/speak`.
- [ ] `[needs-human]` First real Android build: `cd android && ./gradlew build` on a Mac with Android Studio/SDK; fix whatever breaks.
- [ ] `[needs-human]` Deploy brain to Vercel and connect Google account.
- [ ] Site: generate `site/src/styles/tokens.css` from `/design/tokens.json` once it exists.
- [ ] `[needs-human]` Create the Vercel project for the site (Root Directory `site`) and attach a domain; then set `url` in `site/src/content/site.json`.
- [ ] `[needs-human]` Choose a waitlist provider, set `PUBLIC_WAITLIST_ENDPOINT` in Vercel, and replace the placeholder `waitlist.fallbackEmail` in `site/src/content/site.json`.
- [ ] `[needs-human]` Review site copy (especially `/privacy-and-trust` and device statuses) before making it public.
- [ ] `[needs-human]` Order medallion parts (`medallion/HARDWARE.md`), flash, and test with the phone.

## Crew rules
- One backlog item per branch, named `crew/<short-name>`. Open a PR to `main`; never push to `main`.
- Brain changes keep `npx tsc --noEmit` and `npx vitest run` green, and add tests.
- Nothing may ever send a message except `POST /api/drafts/:id/approve` after explicit user confirmation.
- Respect `ARCHITECTURE.md`. If you change the contract, update it and both the TS and Kotlin models.
- Finish by checking off the item here (in the same PR) and adding one line to History.
