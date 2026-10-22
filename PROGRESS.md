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
| UI framework (`/design` + owner dashboard `brain/src/app/(dashboard)`) | Done, tested | Tokens → CSS vars, Tailwind preset, Compose theme (`design/build.mjs`). Dashboard: login (SESSION_SECRET cookie), Today, Follow-ups, Drafts (approve via the existing approve route), Commitments, Devices. Compose theme not compiled yet. |
| QA review | Round 1 done | `QA_REPORT.md`. 8 issues fixed, 6 open (below). |

## History
- 2026-10-16: First session wrote the architecture, brain, and Android apps. Never committed.
- 2026-10-21: Work recovered and pushed. Build crew round 1: Android static fixes, QA review + fixes, medallion firmware.

- 2026-10-21: UI framework: `/design` tokens + generator (CSS, Tailwind preset, Compose theme), owner web dashboard in the brain with signed-session login. Tagline changed to "SideKiqq, it goes where you go."

## Backlog (top = next)

Bots take the first unchecked item that is NOT tagged `[needs-human]`.

- [ ] Brain: `/api/ask` can exceed its 60 s Vercel limit. Add a time budget around the Claude tool loop and return a partial `spoken` reply, with tests. (QA open item)
- [ ] Brain: add `POST /api/devices/:id/revoke` (owner secret) and `GET /api/devices` to revoke a lost device's token, with tests. (QA open item)
- [ ] Brain: bound Redis collections (cap + archive done commitments older than 90 days; paginate reads). (QA open item)
- [ ] Brain: dedupe a commitment that is re-quoted in a later reply on the same thread. (QA open item)
- [ ] Phone/glasses: the voice "send it" confirmation should read a one-sentence summary of the draft body, not just recipient + subject. (QA open item)
- [ ] Watch: allow approving drafts created from `/api/ask` replies (currently only from follow-ups). (QA open item)
- [ ] Phone: adopt `design/dist/kotlin/SideKiqqTheme.kt` (move into `android/shared` or a new `android/shared-ui` module, wire fonts, wrap the root in `SideKiqqTheme`). See `design/README.md`.
- [ ] Watch: adopt the Compose theme via Wear `MaterialTheme` (always dark). See `design/README.md`.
- [ ] Brain: `@upstash/redis` with `automaticDeserialization: false` returns HGETALL as a flat `[field, value, ...]` array, not an object, so `Collection.all()` sees numeric keys and logs "unparseable row" for every field name. Reads only work by accident. Fix in `lib/kv.ts` (convert pairs to an object) with a test against the real client's shape.
- [ ] Dashboard: revoke a device from the Devices screen once `POST /api/devices/:id/revoke` lands.
- [ ] Dashboard: cache the generated brief (each Today visit calls Claude once; Top 5 is already cached for 1 h).
- [ ] Dashboard: server-side session revocation (logout currently clears the cookie; rotating SESSION_SECRET signs out everywhere).
- [ ] Dashboard: the dashboard approves as a paired device of kind `phone` named "Owner web dashboard" (timeline says "approved on phone"). Consider adding a `web` device kind to the contract.
- [ ] Brain: `next build` runs out of memory during type-checking at the default Node heap in a 7 GB sandbox (pre-existing, also on `build-crew-round-1`; likely the `googleapis` types). `NODE_OPTIONS=--max-old-space-size=6144` works. Check Vercel, consider `typescript.ignoreBuildErrors` with tsc in CI.
- [ ] CI: run `node design/build.mjs --check` so generated design outputs never drift.
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
