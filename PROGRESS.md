# SideKiqq — Build Progress & Backlog

This file is the build crew's memory. Every session (human or bot) reads it first and updates it last.

## Module status (as of 2026-10-21)

| Module | Status | Notes |
|---|---|---|
| Architecture & API contract | Done | `ARCHITECTURE.md` (binding). Pairing/connect/push shapes added by QA. |
| Brain backend (`/brain`) | Done, tested | Typecheck clean, 149 tests passing. Not yet deployed. Includes `GET /api/alerts` and `POST /api/speak` for Reachy. |
| Phone companion + Galaxy Glasses (`/android/phone`) | Written, statically fixed | Never compiled. Cloud sandbox can't reach Google Maven. Glasses XR is optional (`-Psidekiqq.xr=false`). |
| Galaxy Watch (`/android/watch`) | Written, statically fixed | Never compiled (same reason). |
| Shared Kotlin client (`/android/shared`) | Written | 42 pure-JVM tests passing. |
| Medallion firmware + hardware guide (`/medallion`) | Done, untested on hardware | Compiles and links for ESP32-S3; 31 native tests pass. See `medallion/HARDWARE.md`. |
| Reachy Mini app (`/reachy`) | Written, tested off-robot | Python `sidekiqq_reachy` ReachyMiniApp (HF Space). 88 pytest tests pass, including integration against the real reachy-mini 1.12.0 SDK classes with a fake robot. `reachy-mini-app-assistant check` passes its structure checks; its venv install step can't run here (PyGObject). Never run on hardware. |
| Marketing site (`/site`) | Built, not deployed | Astro 7 + Tailwind, static. Home, /devices, /privacy-and-trust, /blog, 404. Copy in `site/src/content/`; see `site/EDITING.md`. |
| QA review | Round 1 done | `QA_REPORT.md`. 8 issues fixed, 6 open (below). |

## History
- 2026-10-16: First session wrote the architecture, brain, and Android apps. Never committed.
- 2026-10-21: Work recovered and pushed. Build crew round 1: Android static fixes, QA review + fixes, medallion firmware.
- 2026-10-21: Reachy Mini added as the fifth device (`crew/reachy-mini`): device kind `reachy`, alert log + `GET /api/alerts`, `POST /api/speak` (OpenAI TTS), and the `/reachy` app.
- 2026-10-21: Marketing site built in `/site` (branch `crew/marketing-site`): Astro + Tailwind, schema-checked content, waitlist with mailto fallback.

## Backlog (top = next)

Bots take the first unchecked item that is NOT tagged `[needs-human]`.

### Next up: connectors + tasks (owner priority, 2026-10-21)
SideKiqq should connect to any email, video and grocery service, and run tasks started from any device.
- [ ] Design `docs/CONNECTORS.md`: capability interfaces (`email.send`, `email.read`, `contacts.lookup`, `video.start`, `grocery.cart`, `calendar.*`), the brain as an MCP client, per-connector OAuth with encrypted token storage and minimal scopes, and a per-capability safety policy enforced by the brain (auto / confirm / user-finishes). No connector can bypass draft approval.
- [ ] Brain: implement the connector framework from that doc + a "Connections" screen in the dashboard. Move Gmail/Calendar/Drive onto it.
- [ ] Brain: task layer + device routing. Commands started on any device can run on another device (per-device command queue delivered via FCM or `/api/alerts`-style polling). Commands: `device.call_contact`, `reachy.wake`, `open_url`.
- [ ] Connector: Google Contacts (`contacts.lookup`), so "email this to <name>" resolves people.
- [ ] Task: "email this <dictated paragraph> to <contact>": draft, read back, "send it".
- [ ] Connectors: Google Meet, Zoom (create meeting + send invite after confirm); phone-side call intents (WhatsApp, Samsung/phone video).
- [ ] Task: "start up Reachy and let's do something". The phone on the home LAN calls the Reachy daemon (`/api/apps/start-app/...`), and Reachy offers a dance/game/brief.
- [ ] Connector: Kroger / King Soopers (public API: product search, add to cart; NO checkout or pickup-slot API). Task: "here's my grocery list" fills the cart, then hands checkout to the phone. Never automate payment.
- [ ] Connectors: Outlook / Microsoft 365, generic IMAP/SMTP; investigate Instacart's developer platform terms for other grocery chains.
- [ ] "Request a connector" flow: the build crew generates an MCP connector, opens a PR, and the owner approves before it goes live.
- [ ] Android Auto: messaging-style alerts + voice reply via the phone app, plus a simple Car App Library screen (Top 5, Talk). Driving mode: voice only, no full email on screen, drafts still need a spoken "send it", screen-only tasks wait until parked.
- [ ] (Future) iOS app + CarPlay + Siri Shortcuts.

### Earlier items

- [ ] Brain: `/api/ask` can exceed its 60 s Vercel limit. Add a time budget around the Claude tool loop and return a partial `spoken` reply, with tests. (QA open item)
- [ ] Brain: add `POST /api/devices/:id/revoke` (owner secret) and `GET /api/devices` to revoke a lost device's token, with tests. (QA open item)
- [ ] Brain: bound Redis collections (cap + archive done commitments older than 90 days; paginate reads). (QA open item)
- [ ] Brain: dedupe a commitment that is re-quoted in a later reply on the same thread. (QA open item)
- [ ] Phone/glasses: the voice "send it" confirmation should read a one-sentence summary of the draft body, not just recipient + subject. (QA open item)
- [ ] Watch: allow approving drafts created from `/api/ask` replies (currently only from follow-ups). (QA open item)
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
