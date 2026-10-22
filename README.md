# SideKiqq

**SideKiqq, it goes where you go.**

SideKiqq is a private AI executive assistant, or chief of staff. It reads your email and calendar, tracks every commitment and open loop, tells you who needs a follow-up, briefs you each day, and drafts replies. **It never sends anything without your explicit approval.**

One cloud "brain" does the thinking. Every device you carry or keep nearby is a thin window onto it: a phone, a Galaxy Watch, Galaxy Glasses, a wearable push-to-talk medallion, a Reachy Mini desk robot, and a web dashboard.

```
 [Medallion] --BLE audio--> [Phone companion] <--Wear Data Layer--> [Galaxy Watch]
                                |     \
                                |      \--Bluetooth / Jetpack Projected--> [Galaxy Glasses]
                                v
[Reachy Mini] --HTTPS-->  [SideKiqq Brain on Vercel]  <--HTTPS-- [Web dashboard]
                                |-- Claude API (executive-assistant operating rules)
                                |-- Gmail / Google Calendar / Google Drive (OAuth)
                                |-- Upstash Redis (commitments, open loops, clients, timeline)
                                |-- OpenAI Whisper + TTS (speech in / speech out)
                                \-- FCM push + /api/alerts polling (proactive alerts)
```

## What's in this repo

| Folder | What it is | Status | Docs |
|---|---|---|---|
| [`brain/`](brain/) | Next.js 15 + TypeScript backend on Vercel: the API, Gmail scanning, commitment extraction, briefings, drafts, alerts, speech, and the owner web dashboard | Built and tested, not yet deployed | [brain/README.md](brain/README.md) |
| [`android/`](android/) | Kotlin/Compose: `shared` API client, `phone` companion (also runs the Galaxy Glasses experience and relays the medallion), `watch` (Wear OS app, tile, complication) | Written; not yet compiled against the Android SDK | [android/README.md](android/README.md) |
| [`medallion/`](medallion/) | ESP32-S3 push-to-talk wearable: PlatformIO firmware + hardware guide (BOM, wiring, power, assembly) | Compiles; untested on hardware | [medallion/README.md](medallion/README.md), [HARDWARE.md](medallion/HARDWARE.md) |
| [`reachy/`](reachy/) | Reachy Mini app (Python, published as a Hugging Face Space): tap-to-talk, spoken replies, gestures, urgent-alert attention | Tested off-robot | [reachy/README.md](reachy/README.md) |
| [`design/`](design/) | Design tokens, the single source of truth for colors, type and spacing, generated into CSS, a Tailwind preset and a Compose theme | Built | [design/README.md](design/README.md) |
| [`site/`](site/) | Marketing website (Astro + Tailwind). All copy is in Markdown/JSON so it can be edited by chatting with Claude | Built, not deployed | [site/README.md](site/README.md), [site/EDITING.md](site/EDITING.md) |

Project-wide documents:
- [`ARCHITECTURE.md`](ARCHITECTURE.md): the binding API contract, data models, BLE protocol and auth model.
- [`PROGRESS.md`](PROGRESS.md): module status, history and the prioritized **backlog**. Read it first.
- [`QA_REPORT.md`](QA_REPORT.md): the latest independent QA review, with fixed and open findings.

## The rules SideKiqq is built on

1. **Nothing is sent automatically.** The brain only ever creates drafts. The one and only code path that sends a message is `POST /api/drafts/:id/approve`, and every device puts an explicit confirmation in front of it: a confirm dialog on the phone and dashboard, two taps on the watch, and the spoken words "send it" within 30 seconds on the glasses, medallion or Reachy.
2. **Facts vs. guesses.** Inferred dates and facts are labeled (`dueInferred`, `confidence`) and spoken as "inferred."
3. **Clients stay separate.** One client's details never show up in a reply about another.
4. **Private by default.** Single owner. Google tokens are encrypted at rest. Devices use revocable pairing tokens. The Reachy and the medallion don't stream room audio; they listen only when you press or tap.

The assistant's full operating rules are in [`brain/prompts/operating-system.md`](brain/prompts/operating-system.md).

## Getting it running

Setup happens in three steps: two Vercel projects, then the devices.

1. **Marketing site:** create a Vercel project from this repo with Root Directory `site` (Astro, Node 22+). It works with no environment variables. See [site/README.md](site/README.md).
2. **Brain:** create a second Vercel project with Root Directory `brain`. Set the environment variables in [`brain/.env.example`](brain/.env.example): Anthropic, Upstash Redis, Google OAuth client, owner and session secrets, token encryption key, cron secret, OpenAI (speech), and optionally Firebase. The Gmail scan runs every 30 minutes, which needs **Vercel Pro**; the Hobby plan only allows daily cron jobs. Then connect your Google account and open the dashboard. Details: [brain/README.md](brain/README.md) and the deploy checklist at the end of [QA_REPORT.md](QA_REPORT.md).
3. **Devices:** generate a pairing code from the dashboard and pair each device:
   - Phone + watch: build in Android Studio ([android/README.md](android/README.md)).
   - Medallion: order parts, flash, and pair from the phone ([medallion/HARDWARE.md](medallion/HARDWARE.md)).
   - Reachy Mini: publish the Space and install it from the Reachy dashboard ([reachy/README.md](reachy/README.md)).

## Running the tests

```bash
cd brain    && npm ci && npx tsc --noEmit && npx vitest run   # backend + dashboard
cd site     && npm ci && npm run build                        # site (schema-checked content)
cd reachy   && pip install pytest && pytest                    # Reachy app (uses a fake robot)
cd medallion && pio test -e native                             # firmware logic
cd android  && ./gradlew test                                  # needs the Android SDK
```

## How this repo is built: the build crew

SideKiqq is developed by a crew of AI agents (Claude) working from [`PROGRESS.md`](PROGRESS.md):

- **Every night** a scheduled crew run takes the first backlog item not tagged `[needs-human]`, builds it on a `crew/<name>` branch, has a separate reviewer agent check the diff, updates `PROGRESS.md`, and opens a pull request. It never pushes to or merges into `main`. You review and merge.
- **Items tagged `[needs-human]`** need your hands: deploying, signing in to accounts, ordering hardware, testing on real devices.
- **To change direction**, tell Claude what you want. It goes into the backlog, and the crew picks it up.
- **To edit the website**, tell Claude what to change. It edits the content files, opens a PR, and Vercel builds a preview link for you to approve.

## Roadmap (see PROGRESS.md for the live list)

- **Connector library:** capability-based connectors over MCP (`email.send`, `video.start`, `grocery.cart`, `contacts.lookup`…) so SideKiqq works with any email, video or grocery service you pick, with the approval rule enforced by the brain.
- **Tasks from any device:** "email this to Dana", "start a video call with Mike", "start up Reachy and let's do something", "here's my grocery list, order it at King Soopers for pickup" (fills the cart; you finish checkout).
- **Android Auto + driving mode**, then an iOS app with CarPlay.
- **More channels:** texts, Outlook/IMAP, and Facebook groups where the platform allows.
