# SideKiqq Customer Web App — Design

Status: design only (2026-11-12). Nothing here is built yet. It turns the owner dashboard in
`brain/src/app/(dashboard)` into an installable web app (PWA) for customers and plans multi-tenant
accounts. Native apps stay for what a browser can't do (§9).

The rules that do not change:

- Nothing is sent except through `POST /api/drafts/:id/approve`, after an explicit confirm. On the
  web that confirm is a tap on **Send** in a sheet that shows the draft's `readback` first.
- No push notification, link, voice phrase or command can approve a draft by itself.
- One customer's data is never readable with another customer's credentials (§3.7 has the tests).

Each section ends with the backlog slice it feeds.

---

## 1. Scope: what the web app is

The web app is the existing dashboard, made installable and mobile-first, plus voice. It is
served by the brain (same Next.js app, same origin), so it needs no new CORS rules or API hosts.

| Screen | Web app | Notes |
|---|---|---|
| Sign in | yes | Single-owner secret until accounts land (§3); then "Sign in with Google" |
| Today (brief + Top 5) | yes | Existing `/dashboard` page |
| Follow-ups | yes | Existing; "Draft a reply" creates a Draft as today |
| Commitments | yes | Existing; mark done |
| Drafts + confirm-to-send | yes | Existing `/dashboard/drafts/[id]` confirm; tap Send |
| Talk (tap-to-talk) | yes, foreground only | §6 |
| Alerts | yes | Web Push (§5) + the alert log when the app is open |
| Hand-offs (call, join link) | yes, tap to open | §7 |
| Connections | yes | Existing Connections screen |
| Devices | yes | Pair native devices with a code; revoke (once the revoke API exists) |
| Account | yes (after accounts) | Sign out, sign out everywhere, delete account (§3.6) |
| Medallion, watch, glasses, car, Reachy start | no | Native (§9) |

URLs stay where they are for now (`/login`, `/dashboard/*`) so slice 1 moves no routes. The
manifest uses `start_url: "/dashboard"`, `scope: "/"`, `display: "standalone"`, and the colours
from `/design/tokens.json`. `/design` has no app icons yet; slice 1 renders them (192, 512,
512 maskable, 180 apple-touch) with a generator script whose output is checked in, and adds them
to `design/README.md`. (Since 2026-11-14 the source is the horse mark in `design/mark/`, which also
renders `favicon.ico` for the site and the web app.)

### 1.1 Service worker: offline shell only

Dashboard pages are server-rendered **with the customer's data in the HTML**. Caching a page would
cache drafts, names and email excerpts on the device. So the service worker (`/sw.js`, scope `/`):

- precaches one static `/offline` page ("You're offline. SideKiqq needs a connection."), the icons
  and the manifest;
- caches `/_next/static/*` (content-hashed, no user data) cache-first;
- calls `respondWith` only for (a) navigations to `/dashboard*` and `/login`, served network-only
  with `/offline` as the fallback on a network error, and (b) `/_next/static/*`. Every other
  request passes straight through untouched: `/api/*`, `/auth/*` and OAuth callbacks (no offline
  fallback there either), RSC fetches (`?_rsc=`) and server-action POSTs, which carry personal
  data. No caching, no background sync, no queued approvals;
- never caches a response with `Set-Cookie`, a non-200 status or `Cache-Control: no-store`.

Dashboard pages already get `Cache-Control: private, no-store`, `X-Frame-Options: DENY` and
`Referrer-Policy: same-origin` from `dashboardGuard`; API routes that carry data must send
`no-store` too, so the HTTP cache doesn't keep them either.
Sign-out deletes nothing from the service worker cache because nothing personal is in it; a test
asserts the cache allowlist is only `/offline`, icons, manifest and `/_next/static/`.

**Feeds:** web app slice 1.

---

## 2. Today vs. after accounts

All four web slices can ship with today's single-owner sign-in, but slices 2–4 need the browser
to call device routes (`/api/transcribe`, `/api/ask`, `/api/speak`, `/api/commands`,
`/api/alerts`, `/api/devices/register`). Today those are `withDevice`, the edge middleware 401s
any `/api/*` call without a bearer header, and the browser never holds a device token (the
dashboard's token stays server-side in `lib/dashboard/device-bridge.ts`). So slice 2 starts with
the owner-only version of §4.2: `withPrincipal` (session or device token), the middleware
allowance for the session cookie on those routes, and one `web` device record per signed-in
browser. Accounts (§3) then only change how the tenant is found. Accounts come before any customer
other than the owner signs in.

---

## 3. Multi-tenant accounts

### 3.1 Tenants and keys

- A **tenant** is one customer account. `tenantId` = `t_` + 26 random base32 chars (128 bits).
  It is never derived from an email address or Google id, and never shown to other customers.
- Every key that holds customer data lives under the tenant's **prefix**. A new tenant's prefix is
  `${REDIS_PREFIX}:t:<tenantId>` (e.g. `sk:t:t_8h2…`). All current keys (`sk:drafts`,
  `sk:conn:google:tokens`, `sk:devtok:<hash>`, …) become `sk:t:<tenantId>:drafts` and so on.
- The brain already builds every repo and the `ConnectionStore` from one `prefix`
  (`lib/deps.ts` → `createRepos(kv, { prefix })`). Tenancy is therefore "build deps from the
  tenant's prefix" rather than editing every repo. `Deps` splits into:
  - `PlatformDeps` (shared, no customer data): `kv`, `clock`, `llm()`, `push()`, `transcriber()`,
    `tts()`;
  - `TenantDeps` (per request): `tenant`, `repos`, `connections`, `googleTokens`, `connectors()`,
    `zoomAuth()`, `senders()`, built by `tenantDeps(platform, tenant)`.
  Routes get `TenantDeps` only from a resolved principal (§4). The module-level `getDeps()`
  singleton goes away for tenant data; a tenant object is never cached across requests.
- **Platform keys** (no tenant in the key, because they are how a tenant is found) live under
  `${REDIS_PREFIX}:g:` and are the only global keys allowed:

| Key | Value | Why it is global |
|---|---|---|
| `g:tenant:<tenantId>` | `{ id, prefix, createdAt, status, plan, dek }` | Tenant record (`dek` wrapped, §3.5) |
| `g:ident:google:<sha256(sub)>` | `tenantId` | Sign-in lookup (Google `sub`, never email: emails change) |
| `g:ident:gmail:<sha256(sub)>` | `tenantId` | One connected Google mailbox per tenant (§3.4) |
| `g:devtok:<sha256(token)>` | `{ tenantId, deviceId }` | Device-token lookup (replaces the per-prefix `devtok`) |
| `g:sess:<sha256(sessionId)>` | `{ tenantId, deviceId, createdAt, lastSeenAt }` | Web sessions (§4.1) |
| `g:pair:<sha256(code)>` | `{ tenantId, label }`, TTL | Pairing code → tenant |
| `g:invite:<sha256(code)>` | `{ createdAt }`, TTL, single use | Invite-only sign-up (§3.3) |
| `g:oauth:<state>` / `g:ticket:<ticket>` | `{ tenantId, connectorId }`, TTL | Unauthenticated OAuth legs (§3.4) |
| `g:push:<sha256(endpoint)>` / `g:fcm:<sha256(token)>` | `{ tenantId, deviceId }` | One push target belongs to one device in one tenant (§5) |
| `g:tenants` | hash of tenantId → `{ prefix, googleConnected }` | Cron fan-out (§3.8) |
| `g:rl:*` | counters | Per-IP limits (login, pairing) |

  The tenant record lists its own prefix, so a tenant can be moved by changing one field.
  (`g:` and `t:` here are short for `${REDIS_PREFIX}:g:` and `${REDIS_PREFIX}:t:`.)
- Code that builds keys from `config.redisPrefix()` outside `lib/deps.ts` is moved in A1:
  `lib/dashboard/device-bridge.ts` (`dashboard:device-token`) goes away with the bridge (§4.2),
  `lib/dashboard/owner.ts` (`dashlogin`) becomes `g:rl:login`, and the scan lock in
  `app/api/cron/scan/route.ts` becomes per tenant (§3.8).
- **Per-tenant profile:** the owner's name and time zone are env-wide today
  (`config.ownerName()`, `config.ownerTimezone()`) and `prompts/operating-system.md` names the
  owner. They move to a tenant profile (`name`, `timezone`, set at sign-up, editable on Account);
  the prompt gets a placeholder filled from the profile, and the env values become the owner
  tenant's defaults.

### 3.2 The owner's existing data (zero-copy, then optional move)

The owner's data already sits under `sk:*`. Migration step 1 creates the owner tenant record with
`prefix: "sk"` (the legacy prefix) and links the owner's Google `sub` to it. Nothing is copied
and the owner's devices keep working: on a `g:devtok` miss, auth falls back to the legacy
`sk:devtok:<hash>` lookup **for the owner tenant only**, and writes the `g:devtok` entry so the
fallback is used once per device.

Rules that keep the legacy prefix safe:

- New tenant prefixes are always `sk:t:<id>`. The legacy names `t` and `g` must never be used as
  repo or key names under `sk:`; a test scans the repo key builders for that.
- Account deletion (§3.6) refuses any prefix that is not exactly `${REDIS_PREFIX}:t:<tenantId>`. Deleting by
  `SCAN sk:*` would wipe every customer, so the owner tenant must be moved first.
- Optional step 2 (a script, not a route): copy `sk:<name>` keys for the known names into
  `sk:t:<ownerTenantId>:<name>`, verify counts and hashes, flip the tenant record's `prefix`,
  keep the old keys 7 days, then delete them. Dry-run by default.

### 3.3 Sign-up and sign-in with Google

- **Identity is a separate, small OAuth client flow** from the Gmail connector: scopes `openid
  email profile` only, PKCE, `state` and `nonce`. Signing in never grants Gmail/Calendar access;
  connecting Google on the Connections screen still asks for those scopes with its own consent.
  (Same Google Cloud project is fine. Restricted Gmail scopes still need verification past 100
  test users: the existing `[needs-human]` item.)
- Routes: `GET /auth/google/start` → Google → `GET /auth/google/callback`. The callback verifies
  the ID token (issuer, audience, expiry, nonce, `email_verified`), looks up `g:ident:google:…`,
  and either signs in or creates a tenant.
- **Sign-up is invite-only at first** (`SIGNUP_MODE=invite|open`, default `invite`): a new identity
  needs a single-use invite code minted by the owner. This keeps the account count under the
  Google test-user limit until verification is done.
- The owner tenant is marked `role: "owner"`. Only it may use `OWNER_SECRET` routes (ops
  endpoints). `OWNER_SECRET` maps to the owner tenant and never to any other.
- `POST /api/devices/pair-code` is owner-secret only today; it moves to a session principal so
  each customer pairs devices from their own Devices screen.
- Connector requests become a platform queue (`g:connreq`), each row with `sha256(tenantId)` and
  the request text only, so the owner/crew sees every customer's requests without reading their
  data. Customers see their own requests only.
- **Unverified:** Google sign-in from inside an iOS Home Screen app (the OAuth page is outside the
  app's scope, and Google blocks embedded webviews). Test on a device in A3. Fallback: the app
  opens a same-origin start page that begins the flow, and the callback lands back in scope.

### 3.4 Per-tenant connections

- `ConnectionStore` is built per tenant from its prefix, so tokens live at
  `sk:t:<id>:conn:<connectorId>:tokens`.
- AAD becomes `sidekiqq:conn:<tenantId>:<connectorId>:v2`, so a ciphertext copied into another
  tenant's key fails to decrypt. The owner tenant keeps reading `v1` AAD until its data is moved.
- The connect ticket and OAuth `state` are created by an authenticated tenant but redeemed on
  unauthenticated browser legs. Each is written as `g:ticket:<t>` / `g:oauth:<state>` → tenantId
  plus `connectorId` (single use, GETDEL, same TTLs as today), and the PKCE verifier stays under
  the tenant prefix. The callback takes the tenant only from that record, never from a query
  parameter, and rejects a record whose `connectorId` differs from the route's. The legacy public
  `/api/google/connect` and `/api/google/callback` aliases are deleted before A2.
- On callback, the connected provider account is shown on the Connections screen. One Google
  account may be connected to only one tenant (`g:ident:gmail:<sha256(sub)>`), so a customer
  can't attach someone else's mailbox via a shared sign-in.

### 3.5 Encryption and keys

- Each tenant gets a random 256-bit data key (DEK), stored in its tenant record wrapped
  (AES-256-GCM) by `TOKEN_ENCRYPTION_KEY` (AAD `sidekiqq:dek:<tenantId>`). Connection tokens,
  the dashboard/web device tokens and Web Push subscriptions are encrypted with the tenant DEK.
- Key rotation of `TOKEN_ENCRYPTION_KEY` re-wraps DEKs only (the existing `_PREV` key ring).

### 3.6 Account deletion

`POST /api/account/delete` (session only, re-confirm by typing "delete", then a fresh Google
sign-in within 5 minutes):

1. Mark the tenant `status: "deleting"`; every principal for it is refused from now on.
2. Revoke each connection at the provider (best effort, as disconnect does today).
3. Delete the DEK from the tenant record (crypto-shred: anything missed is unreadable).
4. Delete global index entries: `g:devtok` for each device, `g:sess`, `g:ident:*`, `g:push`,
   `g:fcm`, live pair codes.
5. `SCAN MATCH ${REDIS_PREFIX}:t:<id>:*` and delete in batches (the `KV` interface gains `scanKeys`), then the
   tenant record, then the `g:tenants` entry.
6. A deletion log line with tenantId hash and timestamp only.

It is idempotent and resumable; a cron step finishes any tenant stuck in `deleting`.

### 3.7 Proving no cross-tenant reads

- **Principal-only tenancy:** the tenant is taken only from a credential (session, device token,
  pair code, OAuth state/ticket). No route reads a tenant id from a header, body or query.
- **Static test:** `config.redisPrefix()` may be used only by the platform key module and
  `tenantDeps`; any other use fails the test (like `no-send.test.ts`).
- **Access-log test:** the fake KV records every key touched. A suite creates tenants A and B
  with data, calls every route with A's device token and A's session, and asserts each touched key
  starts with A's prefix or is a listed `g:` key with A's id in its value. For a legacy-prefix
  tenant (the owner, prefix `sk`), the key must also not start with `sk:t:` or `sk:g:`. The suite
  runs twice: A = a normal tenant, and A = the owner tenant. The route list is read from the
  filesystem, so a new route without a case fails.
- **Swap tests:** B's draft id with A's token → 404 (not 403, to avoid confirming existence);
  B's connect ticket in A's session; a v2 ciphertext copied from B to A fails to decrypt.
- Claude context: conversations, timeline and clients are tenant repos, so a prompt is built only
  from one tenant's data. Logs carry `sha256(tenantId)` prefixes, never content.

### 3.8 Cron, limits and caps

- **Scan fan-out:** `/api/cron/scan` takes tenants from `g:tenants` with Google connected, oldest
  scan first, and scans as many as fit in a 240 s budget, with a per-tenant lock
  `sk:t:<id>:lock:scan`. Each tenant still gets its own cursor and backlog handling (QA H1). At
  more than a few dozen tenants, this needs Vercel Pro's frequent cron or a queue (QStash): an
  owner decision.
- **Per-tenant limits** (env-configurable, 429 `tenant_limit` with `retryAfter`):
  `/api/ask` 20/min and a daily Claude token budget; `/api/transcribe` 30 min audio/day;
  `/api/speak` 20 000 chars/day; 10 paired devices; 5 browsers with push; 200 pending drafts.
- **Platform caps:** a global daily spend ceiling for Claude/OpenAI that turns off voice and
  briefs for everyone (with a clear message) instead of overspending.
- **Pairing codes** stay 6 digits for existing device apps, are written `NX` so two tenants never
  share a live code, and keep the per-IP limit. A global failed-attempt count only raises an
  owner alert (it never blocks pairing, so one attacker can't lock out every tenant). Once there
  are many tenants, move to 8 digits (device apps should accept 6–8 now).

**Feeds:** "Brain: multi-tenant accounts" (slices A1–A8 in §10).

---

## 4. Web sessions vs. device tokens

| | Web session | Device token |
|---|---|---|
| Who | A browser (installed PWA or tab) | Phone, watch, glasses, medallion via phone, Reachy, iPhone |
| How issued | Google sign-in (owner secret until accounts) | One-time pairing code from the web app's Devices screen |
| Carried as | `__Host-skq_session` cookie (renamed from today's `skq_session`): HttpOnly, Secure, SameSite=Strict, Path=/ | `Authorization: Bearer` |
| Lifetime | 30 days, sliding on use (today: 7 days fixed) | Until revoked |
| Revocation | Delete `g:sess` record and that browser's `web` device (with its push subscription; the client also calls `pushSubscription.unsubscribe()`); "Sign out everywhere" and session expiry do the same for each | `POST /api/devices/:id/revoke` (backlog) |
| CSRF | `Origin` / `Sec-Fetch-Site` must be same-origin on every non-GET; on session-authenticated device routes it fails closed (both headers missing = refused; today `requireOwnerOrSession` lets that through) | Not cookie-based |

### 4.1 Session format

Today's cookie is stateless (`v1.<exp>.<nonce>.<sig>`) and can't be revoked one at a time. `v2`
is `v2.<sessionId>.<sig>` with the record in `g:sess:<sha256(sessionId)>`. Signing (HMAC with
`SESSION_SECRET`) stays as a cheap edge pre-check; the Node route checks the record. This closes
"Dashboard: server-side session revocation". The rename and format change touch `middleware.ts`
(including its connections-cookie bypass), `lib/dashboard/guard.ts` and `lib/dashboard/owner.ts`.
Existing v1 cookies are refused once A3 ships, so the owner signs in once more.

Google's callback is a cross-site navigation, so a `SameSite=Strict` cookie set on its 302
redirect may not be sent on the next request. The callback sets the cookie and returns a tiny
same-origin page that moves on to `/dashboard` with a `<meta http-equiv="refresh">` and a plain
link (no inline script, so it passes the CSP in §8).

iOS keeps a Home Screen web app's cookies and storage separate from Safari. A customer who signed
in in Safari must sign in again inside the installed app; the install screen says so.

### 4.2 One principal, one approve path

Today the dashboard calls device routes in-process as a hidden paired device ("Owner web
dashboard", kind `phone`). With a `web` device kind (§6.3):

- each signed-in browser gets its own device record (`web`, named like "Chrome on Android"),
  linked from its session. Its push subscription, its hand-offs and its revoke belong to that
  browser, and the timeline says "approved on web";
- device routes move from `withDevice` to `withPrincipal`, which accepts a device token **or** a
  session (plus the fail-closed CSRF check) and yields the same `{ tenant, device }`. The approve
  route stays the single executor;
- **the confirm check moves into the approve route for sessions.** Today it lives only in the
  bridge: `approveDraftFromDashboard` (`lib/dashboard/approval.ts`) requires `confirm="send"` and
  a fingerprint of what the dialog showed (`draftFingerprint`), recomputed on the server. With a
  session principal, `POST /api/drafts/:id/approve` requires `{ "confirmation": <fingerprint> }`
  in the body, computed by the same `draftFingerprint`, and returns 409 `changed` (nothing sent)
  on a mismatch. Device-token callers keep today's body (their confirm is on the device). The
  bridge stays until this exists and is tested; then it is removed;
- the hidden "Owner web dashboard" device (kind `phone`, touched on every dashboard action) is
  migrated to kind `web` in slice 2, so `resolveTarget` no longer sends phone hand-offs to a
  device that never polls. Until then it is excluded from targeting;
- `/api/connections*` and other owner routes keep refusing device tokens.

**Feeds:** web app slice 2 (device kind), accounts A3 (sessions).

---

## 5. Web Push next to FCM

- Keys: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` or the site URL).
  Sending uses the `web-push` npm package in the Node runtime (RFC 8291 encryption).
- **Subscribe** (only on a user tap of "Turn on alerts", never on page load): service worker
  `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, then
  `POST /api/devices/register` with `{ "transport": "webpush", "subscription": { endpoint, keys:
  { p256dh, auth } } }`. `transport` defaults to `"fcm"` (current body unchanged);
  `RegisterDeviceSchema`'s `fcmToken` becomes required only when `transport` is `"fcm"`. The APNs
  item adds `"apns"` the same way. Contract change: ARCHITECTURE.md, TS, Kotlin, Swift models.
- **Endpoint allowlist:** the brain POSTs to the endpoint, so it must be `https` on a known push
  service host (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.apple.com`,
  `*.notify.windows.com`), with no credentials or port. Others get 400. This blocks SSRF.
- **Storage:** on the browser's `web` device record, encrypted with the tenant DEK. The global
  `g:push:<sha256(endpoint)>` index (and `g:fcm:<sha256(token)>` for FCM, replacing today's
  per-prefix de-dup in `setFcmToken`) maps each target to one device in one tenant. On register,
  the endpoint or token is cleared from any other device in any tenant, so a browser or phone
  reused by another account never gets the previous account's alerts.
- **Delivery:** `deliverAlert` (`lib/push/alerts.ts`) already writes the alert log and calls FCM;
  it also sends Web Push to the tenant's `web` devices. The payload is the alert's
  `title`, `body`, `kind`, `importance` and ids, the same as the FCM data, and nothing more (no
  draft bodies). TTL 24 h; `Urgency: high` for CRITICAL, `normal` otherwise.
- **Errors:** 404/410 clear that subscription. 400/413 and 5xx do not (as with QA H3: a payload
  problem must not drop subscriptions). 429 backs off.
- **No silent pushes.** Every web push must show a notification (iOS revokes subscriptions that
  don't), so the command nudge is not sent to `web` devices; they read hand-offs while open.
- **Service worker:** `push` shows the notification built from the payload; `notificationclick`
  focuses or opens `/dashboard` (or the related screen), chosen from a fixed list of same-origin
  paths by `kind`, never from a URL in the payload. No notification actions: nothing can be
  approved or sent from a notification.
- **Lock-screen content:** the alert `body` can include client names and an email gist, as FCM
  does today. Account gains an "Alerts hide content" setting that sends only a generic title.
- **iOS:** Web Push works only in a Home Screen web app on iOS/iPadOS 16.4+. In a Safari tab the
  app shows "Add to Home Screen to get alerts" instead of the button. Android Chrome and desktop
  browsers work in a tab.
- **Fallback:** while the app is open it polls `GET /api/alerts` every 60 s (cursor kept in
  memory), so alerts still show where push is denied or unsupported.

**Feeds:** web app slice 3.

---

## 6. Browser tap-to-talk

### 6.1 Capture and upload

1. On a tap of **Talk**: create or `resume()` an `AudioContext` in the tap handler (required on
   iOS), then `getUserMedia({ audio: { channelCount: 1, echoCancellation: true,
   noiseSuppression: true, autoGainControl: true } })`.
2. An `AudioWorklet` collects mono Float32 frames at the context's real rate (usually 48 kHz;
   browsers may ignore a requested rate). The worklet low-pass filters and resamples to
   16 kHz, converts to PCM16 LE, and posts chunks to the page.
3. Tap again (or 2 s of silence by a simple energy gate, or 60 s max) stops. The page stops every
   mic track at once, so the browser's mic indicator goes off: there is no open mic between turns.
4. The page writes a 44-byte WAV header (16 kHz, mono, 16-bit) and POSTs `audio/wav` to
   `/api/transcribe` (brain limit 120 s; the client caps at 60 s).

`MediaRecorder` isn't used: it produces WebM/MP4, and the brain accepts only 16 kHz PCM16 WAV.
The WAV and resampler are pure functions with unit tests (sample count, header bytes, a 1 kHz
tone survives, an 11 kHz tone is attenuated).

### 6.2 Ask and reply

- Show the transcript, then `POST /api/ask` with `{ text, device: "web", conversationId }`.
  The route uses the principal's device kind; a body `device` that differs from it is rejected
  with 400 (today `runAsk` puts the body's value into the prompt while the tools use the
  authenticated kind).
- Show `reply`; speak `spoken` via `POST /api/speak` (24 kHz WAV) played through the same
  `AudioContext`. A "mute voice" toggle (stored locally) skips `/api/speak`.
- A `draft_created` action shows the Draft card with its `readback` and a **Send** button that
  opens the normal confirm sheet. A spoken "send it" is not accepted on the web for now; adding it
  later must follow the device rule exactly (30 s window that opens only after the read-back has
  fully played, speech that started earlier can't confirm, re-fetch the draft before approve).

### 6.3 Contract: `web` device kind

`DeviceKind` gains `"web"` in `DEVICE_KINDS` (TS), the Kotlin `Device` enum, Swift `DeviceKind`
and ARCHITECTURE.md, including `/api/ask`'s `device` field. Native clients must tolerate `web` in
`from` fields and timelines. This also closes "Dashboard: … consider adding a `web` device kind".

**Feeds:** web app slice 2.

---

## 7. Hand-offs as tap-to-open links

- `open_url` and `call_contact` may target a `web` device. Target default: the most recently
  seen phone (as today), else the most recently seen `web` device. `reachy_start` stays phone-only:
  an `https` page can't call the robot's `http://*.local` daemon (mixed content, no mDNS).
- The app reads `GET /api/commands` while visible (every 15 s, plus on focus) and shows each
  command as a card: `label`, then the number or host on its own line, then a link.
- Links are built in the browser from validated fields, never from `label`:
  `tel:` + the number (re-checked: digits and `+ ( ) . -` and spaces, 3–15 digits, no `* # , ;`),
  or the `url` (re-checked: `https`, no credentials or port, host on the same allowlist as the
  brain). WhatsApp: `https://wa.me/<digits>`. A failing check shows "Can't open this hand-off" and
  acks `failed`.
- Nothing opens automatically: no `window.open`, no `location` assignment, no auto-click. The
  owner taps the link; the click acks `opened`. A Dismiss button acks `dismissed`. Expired
  commands vanish when the next GET no longer lists them.
- `rel="noopener noreferrer"` and `target="_blank"` on https links; `tel:` opens the dialer, which
  still needs the owner's Call tap.

**Feeds:** web app slice 4.

---

## 8. Security headers for the app shell

Slice 1 adds to dashboard and app routes (on top of what `dashboardGuard` already sets): a
`Content-Security-Policy` with a per-request nonce from middleware (`default-src 'self'`;
`script-src 'self' 'nonce-<n>' 'strict-dynamic'`, which Next.js App Router needs for its inline
hydration scripts; `style-src 'self' 'unsafe-inline'` until React `style={}` attributes are audited
out; `connect-src 'self'`; `media-src 'self' blob:`; `worker-src 'self'`; `frame-ancestors 'none'`;
no third-party script), `Permissions-Policy: microphone=(self), camera=(), geolocation=()` and
`X-Content-Type-Options: nosniff`. The AudioWorklet module is a same-origin file, not a `blob:`
URL (worklets follow `script-src`). `/sw.js` is served with
`Cache-Control: no-cache` and `Service-Worker-Allowed: /`.

---

## 9. What stays native, and why

| Need | Browser limit | Native app |
|---|---|---|
| Medallion press-to-talk | Web Bluetooth is Chromium only (Android/desktop), foreground, needs a tap per connect, no background; absent on iOS | Phone app (background BLE), iPhone app (CoreBluetooth restoration) |
| Always-on / wake word | No background mic; mic stops when the page is hidden | Phone, Reachy |
| Galaxy Watch, Galaxy Glasses | Can't run web apps | Wear OS app, phone app (Projected) |
| Lock-screen / background voice | Page must be visible | Phone, iPhone |
| Alerts relayed to watch / medallion haptic | Web Push reaches only that browser | Phone app relay |
| Driving (Android Auto / CarPlay) | Not available to web apps | Native car surfaces |
| Silent command nudges | Web Push must always show a notification | FCM data messages |
| Start Reachy on the LAN | https page can't reach `http://*.local` | Phone app |

---

## 10. Build order

Web app (single owner, can start now):

1. **Slice 1:** manifest, icons, `/offline`, service worker (§1.1), `no-store` + security headers
   (§8), mobile-first layout check of Today/Follow-ups/Commitments/Drafts. Tests: cache allowlist,
   SW never handles `/api/*`, headers present.
2. **Slice 2:** owner-only `withPrincipal` + middleware allowance + one `web` device per browser
   (§2, §4.2), with the approve-route confirmation fingerprint and fail-closed CSRF; migrate the
   hidden dashboard device to `web`; `web` device kind (contract + TS + Kotlin + Swift); Talk
   screen (§6). Tests: approve via session without/with a stale fingerprint sends nothing, CSRF
   with missing headers refused, WAV and resampler, `/api/ask` accepts `web` and rejects a
   mismatched body `device`.
3. **Slice 3:** Web Push (§5). Tests: endpoint allowlist, register body, error handling per
   status, payload has no draft body.
4. **Slice 4:** hand-offs on the web (§7). Tests: link building rejects bad numbers/hosts, no
   auto-open.

Multi-tenant accounts (before any second customer):

- **A1** `PlatformDeps`/`TenantDeps` split; owner tenant record with `prefix: "sk"`; static
  prefix test. No behaviour change.
- **A2** Global indexes (`g:devtok` with owner fallback, `g:pair`, `g:oauth`, `g:ticket`,
  `g:push`, `g:fcm`); `withPrincipal` resolves the tenant; delete the legacy Google aliases.
- **A3** Google sign-in, invite codes, v2 sessions, per-tenant profile, session-auth
  pair-code, platform connector-request queue.
- **A4** Tenant DEKs and v2 connection AAD.
- **A5** Cron fan-out across tenants.
- **A6** Per-tenant limits and the platform spend cap.
- **A7** Account deletion (+ `KV.scanKeys`).
- **A8** Cross-tenant access-log suite (§3.7) gating every later route.
- Optional: owner data move script (§3.2).

---

## 11. Open questions for the owner

- Invite-only sign-up until Google verification is done: is that right, and who gets invites?
- Who pays model costs per customer, and what daily caps should the first plan have (§3.8)?
- Scan frequency for customers: Vercel Pro cron or a queue (QStash) once there are more than a few
  dozen accounts?
- Should customers be able to pair native devices (watch, medallion) from day one, or web only?
- Domain for the web app (already a `[needs-human]` item); the PWA's `start_url` and Google
  OAuth redirect URIs depend on it.
