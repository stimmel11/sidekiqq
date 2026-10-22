# SideKiqq — Build Progress & Backlog

This file is the build crew's memory. Every session (human or bot) reads it first and updates it last.

## Module status (as of 2026-10-21)

| Module | Status | Notes |
|---|---|---|
| Architecture & API contract | Done | `ARCHITECTURE.md` (binding). Pairing/connect/push shapes added by QA. |
| Brain backend (`/brain`) | Done, tested | Typecheck clean, 131 tests passing. Not yet deployed. |
| Phone companion + Galaxy Glasses (`/android/phone`) | Written, statically fixed | Never compiled. Cloud sandbox can't reach Google Maven. Glasses XR is optional (`-Psidekiqq.xr=false`). |
| Galaxy Watch (`/android/watch`) | Written, statically fixed | Never compiled (same reason). |
| Shared Kotlin client (`/android/shared`) | Written | 42 pure-JVM tests passing. |
| Medallion firmware + hardware guide (`/medallion`) | Done, untested on hardware | Compiles and links for ESP32-S3; 31 native tests pass. See `medallion/HARDWARE.md`. |
| QA review | Round 1 done | `QA_REPORT.md`. 8 issues fixed, 6 open (below). |

## History
- 2026-10-16: First session wrote the architecture, brain, and Android apps. Never committed.
- 2026-10-21: Work recovered and pushed. Build crew round 1: Android static fixes, QA review + fixes, medallion firmware.

## Backlog (top = next)

Bots take the first unchecked item that is NOT tagged `[needs-human]`.

- [ ] Brain: `/api/ask` can exceed its 60 s Vercel limit. Add a time budget around the Claude tool loop and return a partial `spoken` reply, with tests. (QA open item)
- [ ] Brain: add `POST /api/devices/:id/revoke` (owner secret) and `GET /api/devices` to revoke a lost device's token, with tests. (QA open item)
- [ ] Brain: bound Redis collections (cap + archive done commitments older than 90 days; paginate reads). (QA open item)
- [ ] Brain: dedupe a commitment that is re-quoted in a later reply on the same thread. (QA open item)
- [ ] Phone/glasses: the voice "send it" confirmation should read a one-sentence summary of the draft body, not just recipient + subject. (QA open item)
- [ ] Watch: allow approving drafts created from `/api/ask` replies (currently only from follow-ups). (QA open item)
- [ ] Medallion + phone: BLE bonding/encryption, so the phone pairs only to the owner's medallion.
- [ ] Brain: a `docs/DEPLOY.md` step-by-step for Vercel (Pro plan for 30-min cron), Upstash, Google Cloud OAuth consent, FCM, env vars.
- [ ] Phase 2 design: texts (Android SMS via the phone companion), Facebook groups (API limits; investigate options), Outlook. Write `docs/CHANNELS.md` with a recommendation before building.
- [ ] `[needs-human]` First real Android build: `cd android && ./gradlew build` on a Mac with Android Studio/SDK; fix whatever breaks.
- [ ] `[needs-human]` Deploy brain to Vercel and connect Google account.
- [ ] `[needs-human]` Order medallion parts (`medallion/HARDWARE.md`), flash, and test with the phone.

## Crew rules
- One backlog item per branch, named `crew/<short-name>`. Open a PR to `main`; never push to `main`.
- Brain changes keep `npx tsc --noEmit` and `npx vitest run` green, and add tests.
- Nothing may ever send a message except `POST /api/drafts/:id/approve` after explicit user confirmation.
- Respect `ARCHITECTURE.md`. If you change the contract, update it and both the TS and Kotlin models.
- Finish by checking off the item here (in the same PR) and adding one line to History.
