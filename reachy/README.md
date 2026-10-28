---
title: SideKiqq Reachy
emoji: 🗂️
colorFrom: green
colorTo: gray
sdk: static
pinned: false
short_description: A desk-robot face for a private AI executive assistant
tags:
 - reachy_mini
 - reachy_mini_python_app
---

# SideKiqq on Reachy Mini

A [Reachy Mini](https://huggingface.co/docs/reachy_mini) app that makes the robot a desk-side
interface to a **SideKiqq brain**, a private, single-owner AI executive assistant (Next.js on
Vercel, in `/brain` of the SideKiqq repo). The robot does no thinking itself. It listens, sends
your words to your brain, speaks the answer, and reacts to urgent alerts.

- **Tap to talk** from the settings page, or an optional on-device wake word (off by default).
- **Thinks visibly.** The antennas ponder while the brain works, and the robot nods when the
  reply has been delivered.
- **Urgent alerts.** It polls the brain's `GET /api/alerts` about every 60 s. For CRITICAL or HIGH
  items it makes an attention gesture and plays a short chime. It reads them aloud only if you
  turn on "Speak urgent alerts".
- **Brief me** speaks your daily briefing (`GET /api/brief?kind=daily`).
- **Wake from another device.** "Wake Reachy to chat / read my brief / dance / play a game" on
  your phone or watch queues a `reachy_wake` command. The robot polls `GET /api/commands` on the
  alert thread (every 30 s, or the alert interval if shorter, with the same backoff) and then:
  - **chat:** wake-up sound and a greeting, then one listen, exactly like pressing **Talk**.
  - **brief:** the daily brief, like **Brief me**.
  - **dance:** a short dance (motion and the SDK's dance sound, no network).
  - **game:** there is no game yet, so it says games are coming soon (acked `failed`).

  It acks each one (`POST /api/commands/:id/ack`: `opened`, or `failed` if it couldn't run).
  A wake never interrupts anything: if the robot is mid-turn, listening, speaking or waiting
  for "send it", the wake waits and runs once it is idle. If it waited more than 2 minutes it is
  dropped and acked `dismissed`, so a chat never opens the mic long after you asked (a chat is
  also dismissed if the brain created it more than 3 minutes ago, e.g. the robot was offline).
  If the brain stops listing it (expired), it is dropped without acting. **Cancel** also stops
  a chat's pending listen. Handled ids are saved in the config file, so a re-delivered command
  or a restart never repeats a wake. Other command kinds are ignored and not acked.
- **Voice-confirmed drafts.** When a reply creates an email draft, the robot reads back the
  recipient, the subject and a one-sentence summary of the body. It sends only if your next words
  are exactly **"send it"** within 30 seconds. Anything else, silence or the Cancel button leaves
  the draft unsent. This is the same rule the SideKiqq glasses and medallion use.

## Privacy

- **No room audio goes to the cloud by default.** The mic stream is read on the robot and thrown
  away until you press **Talk**. Only that one utterance (16 kHz mono WAV) is uploaded to *your*
  brain's `/api/transcribe`.
- **The wake word is off by default.** If you turn it on, detection runs on the robot
  (openWakeWord). Only what you say after the wake word is uploaded.
- While the robot is speaking or thinking, mic audio is discarded (half duplex).
- The device token is stored in `~/.config/sidekiqq_reachy/config.json` (or
  `$SIDEKIQQ_REACHY_CONFIG`) with `0600` permissions, in a `0700` folder. The settings page never
  shows it.
- The settings page (port 8042) has no login, so keep the robot on a trusted network. To limit
  what it exposes, the page shows status only: no transcripts, replies, names or alert text. Every
  POST requires a JSON body, so other websites can't drive it with cross-site form posts.
- Nothing is ever sent on your behalf except through the brain's
  `POST /api/drafts/:id/approve`, after the spoken "send it" confirmation.

## Setup

1. **Brain:** deploy the SideKiqq brain. Set `OPENAI_API_KEY` there, because `/api/speak` uses
   OpenAI TTS.
2. **Install the app on the robot:** in the Reachy Mini dashboard, open the app store, search for
   **SideKiqq Reachy** and install it. Or install from the Space URL:
   ```bash
   curl -X POST http://reachy-mini.local:8000/api/apps/install \
     -H "Content-Type: application/json" \
     -d '{"url": "https://huggingface.co/spaces/<you>/sidekiqq_reachy"}'
   ```
3. **Start it** from the dashboard. Then open the settings page with the gear icon, or go to
   `http://reachy-mini.local:8042` (Wireless) or `http://localhost:8042` (Lite).
4. **Pair:** get a one-time code from the brain:
   ```bash
   curl -X POST https://<brain>/api/devices/pair-code -H "X-Owner-Secret: $OWNER_SECRET" \
     -H "Content-Type: application/json" -d '{"label":"Desk robot"}'
   ```
   Enter the brain URL and the 6-digit code, then press **Pair**. The robot registers as device
   kind `reachy`.
5. Press **Talk** and ask, for example, "What's on my plate today?"

### Optional wake word
Run `pip install "sidekiqq_reachy[wakeword]"` in the robot's app environment
(`/venvs/apps_venv/` on Wireless). Then tick **Wake word** on the settings page. The default model
is openWakeWord's `hey_jarvis`. A custom "hey SideKiqq" model can be trained with openWakeWord and
set by name or path.

## Brain API used

| Call | Purpose |
|---|---|
| `POST /api/devices/pair` | `{code, device: "reachy"}` → long-lived token |
| `POST /api/transcribe` | 16 kHz mono PCM16 WAV → `{text}` |
| `POST /api/ask` | `{text, device: "reachy", conversationId?}` → `{reply, spoken, actions}` |
| `POST /api/speak` | `{text, voice?}` → `audio/wav`: PCM16 mono, 24 kHz (rate is in the header). Max 1000 chars; longer replies are split at sentences |
| `GET /api/alerts?since=` | Same alerts as the phone's FCM pushes, plus a cursor (saved locally) |
| `GET /api/commands` | `reachy_wake` hand-offs from your other devices, deduped by id |
| `POST /api/commands/:id/ack` | `{result: "opened"\|"dismissed"\|"failed"}` after running (or dropping) a wake |
| `GET /api/brief?kind=daily` | Daily briefing |
| `GET /api/drafts` | Read-only: draft body for the one-sentence read-back |
| `POST /api/drafts/:id/approve` | Only after an exact "send it" |

## Development

```bash
pip install -e ".[dev]"   # needs reachy-mini (GStreamer/PyGObject) for main.py
pytest                    # tests/test_app_sdk.py is skipped when the SDK isn't importable
reachy-mini-app-assistant check .
reachy-mini-daemon --sim  # then: python -m sidekiqq_reachy.main
```

The pure logic is unit-tested without a robot: endpointing, WAV framing, the confirmation state
machine, the alert cursor, the command poller (dedupe, liveness, acks, wake modes), speech
splitting and the API client against a fake brain.

If PyGObject won't build (no GStreamer dev headers), `tests/test_app_sdk.py` can still run: make
the venv with a Python that has a system `gi` (`python3.12 -m venv --system-site-packages`), then
`pip install --no-deps reachy-mini==1.12.0` plus its other dependencies, and
`pip install --no-deps -e ".[dev]"`.

## Publish to Hugging Face

```bash
pip install --upgrade huggingface_hub
hf auth login                                  # token with Write permission
reachy-mini-app-assistant publish ./reachy     # creates/pushes the Space
```

After publishing, install it from the Reachy Mini dashboard (step 2 above). Later updates are a
normal `git push` to the Space remote.

## Layout

```
reachy/
├── README.md, index.html, style.css   # Space card + landing page
├── pyproject.toml                     # entry point: reachy_mini_apps → sidekiqq_reachy.main:SidekiqqReachy
├── sidekiqq_reachy/
│   ├── main.py         # ReachyMiniApp, settings routes (/sk/*), voice loop
│   ├── assistant.py    # one voice turn: transcribe → ask → speak → draft confirmation
│   ├── confirm.py      # "send it" state machine (mirror of DraftConfirmation.kt)
│   ├── audio.py        # mic conversion, energy endpointing, WAV framing, chime
│   ├── alerts.py       # /api/alerts poller with persisted cursor and backoff
│   ├── commands.py     # /api/commands poller (dedupe, liveness, acks) + reachy_wake activities
│   ├── api.py          # brain HTTP client (stdlib)
│   ├── config.py       # settings + 0600 config file
│   ├── controller.py   # state shared with the settings page
│   ├── expressions.py  # poses, antennas, sounds, playback
│   ├── speech.py       # text splitting, spoken brief
│   ├── wakeword.py     # optional openWakeWord wrapper
│   └── static/         # settings page
└── tests/
```
