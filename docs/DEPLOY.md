# Deploying the SideKiqq brain

This guide takes the brain from nothing to a live URL your phone can pair with. It takes about an hour, and most of
that is clicking through consoles. Do the steps in order: Google needs your Vercel URL, and the app needs Google.

What you end up with:
- the brain live at `https://<project>.vercel.app`
- your Google account connected (Gmail, Calendar, Drive and Contacts are read-only; Gmail can also write drafts)
- an owner dashboard you can sign in to
- a pairing code ready for the phone

Nothing in this setup can send email on its own. Sending only happens when you approve a draft
(`POST /api/drafts/:id/approve`).

## 0. What you need

| Account | Used for | Required? |
|---|---|---|
| Vercel | hosting the brain | yes |
| Upstash | Redis storage (commitments, drafts, device tokens, encrypted sign-ins) | yes (free tier is fine) |
| Anthropic API key | Claude, at console.anthropic.com | yes |
| Google Cloud project | the OAuth client for Gmail, Calendar, Drive and Contacts | yes |
| OpenAI API key | speech-to-text (`/api/transcribe`) and text-to-speech (`/api/speak`) | only for voice; skip it for the first test |
| Firebase project | push alerts to the phone | no; without it alerts are logged, and the phone still polls |

You also need a terminal with `openssl`, to generate secrets.

## 1. Generate the secrets

Run these four commands and save each output in a password manager. You'll paste them into Vercel in step 3.

```bash
openssl rand -base64 32   # OWNER_SECRET: your dashboard password and the pairing key
openssl rand -base64 48   # SESSION_SECRET: signs the dashboard cookie
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY: encrypts stored sign-ins. Losing it means reconnecting everything
openssl rand -base64 32   # CRON_SECRET: Vercel Cron sends this to /api/cron/scan
```

## 2. Upstash Redis

1. Go to console.upstash.com, then **Create database**. Choose a region near your Vercel region (e.g. `us-east-1`).
   You can turn eviction off or leave the default.
2. Open the database's **REST API** section and copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

You can use the Vercel Upstash integration instead. Its `KV_REST_API_URL` / `KV_REST_API_TOKEN` are accepted too.

## 3. Vercel project

1. In Vercel, go to **Add New → Project** and import `stimmel11/sidekiqq`.
2. Set **Root Directory** to `brain`. Leave the framework (Next.js) and the build command (`npm run build`) as they are.
   This is a separate project from the marketing `site` project.
3. **Cron and your plan:** `brain/vercel.json` runs `/api/cron/scan` every 30 minutes. A Hobby plan allows cron jobs
   at most once a day, and Vercel rejects the deployment if the schedule is more frequent. Pick one:
   - Pro plan: leave it as it is.
   - Hobby plan for now: change the schedule in `vercel.json` to `"0 13 * * *"` (daily, 13:00 UTC). Then run the
     scan by hand whenever you like:
     `curl -X POST https://<project>.vercel.app/api/cron/scan -H "Authorization: Bearer $CRON_SECRET"`.
4. Under **Environment Variables**, add the following. They apply to Production, and to Preview too if you want
   preview deploys to work.

   | Variable | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your key |
   | `OWNER_SECRET` | from step 1 |
   | `SESSION_SECRET` | from step 1 |
   | `TOKEN_ENCRYPTION_KEY` | from step 1 |
   | `CRON_SECRET` | from step 1 |
   | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | from step 2 |
   | `OWNER_TIMEZONE` | e.g. `America/Denver` |
   | `APP_URL` | `https://<project>.vercel.app`. Set it explicitly so OAuth redirects never point at a preview URL |
   | `OPENAI_API_KEY` | optional (voice) |

   Leave `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` empty for now. You get them in step 4.
5. Click **Deploy**. When it finishes, open `https://<project>.vercel.app/api/health`. It should answer
   `{"ok":true,"service":"sidekiqq-brain"}`. If the build fails with "JavaScript heap out of memory", see Troubleshooting.

## 4. Google Cloud OAuth

1. At console.cloud.google.com, create a project (e.g. "SideKiqq").
2. Under **APIs & Services → Library**, enable the **Gmail API**, **Google Calendar API**, **Google Drive API** and
   **People API**.
3. Configure the **OAuth consent screen** (Google Auth Platform):
   - User type: External.
   - App name: SideKiqq.
   - Support and developer email: yours.
   - Add yourself under **Test users**.
4. Under **Clients → Create client**, choose type **Web application**.
   - **Authorized redirect URIs:** `https://<project>.vercel.app/api/google/callback`. This must match exactly, with
     no trailing slash. Add `http://localhost:3000/api/google/callback` too if you'll run the brain locally.
   - Copy the client ID and secret.
5. Back in Vercel, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Optionally set `GOOGLE_ALLOWED_EMAIL` to your
   address, so no other Google account can be connected. Then **Redeploy**, because environment changes need a new
   deployment.

**The 7-day catch:** while the consent screen is in **Testing**, Google expires the refresh token after 7 days. The
dashboard then shows Google as "needs reconnect", and you reconnect in one click. To stop this, publish the app
(**Publish app**). Google may ask for verification because of the Gmail scopes. For a single-user app you can usually
keep it unverified and click through the "unverified app" warning yourself.

The scopes requested are `gmail.readonly`, `gmail.compose` (drafts only; sending happens only through approve),
`calendar.readonly`, `drive.readonly`, `contacts.readonly`, `contacts.other.readonly`, and `openid email`.

## 5. Sign in and connect Google

1. Open `https://<project>.vercel.app/login` and paste your `OWNER_SECRET`. You stay signed in on that browser for
   7 days.
2. Go to **Connections → Google → Connect**, approve on Google's screen, and you land back on Connections showing
   **Connected** with your address.
3. Optional first scan: run the curl from step 3.3. After that, **Today** and **Follow-ups** should show real items.

## 6. Pair the phone

1. In the dashboard, go to **Devices → Create pairing code**. The code is 6 digits, single use, and lasts 10 minutes.
2. In the phone app's pairing screen, enter:
   - **Server URL:** `https://<project>.vercel.app`. It must be `https`; the app refuses `http://` except for local
     dev hosts.
   - **Code:** the 6 digits.
3. The phone appears under **Devices**. The watch pairs automatically through the phone.

You can also pair without the app, to test the API:

```bash
BRAIN=https://<project>.vercel.app
curl -s -X POST $BRAIN/api/devices/pair-code -H "Authorization: Bearer $OWNER_SECRET"
curl -s -X POST $BRAIN/api/devices/pair -H 'content-type: application/json' -d '{"code":"123456","device":"phone","name":"curl"}'
curl -s -X POST $BRAIN/api/ask -H "Authorization: Bearer <token from the line above>" -H 'content-type: application/json' \
  -d '{"text":"What am I waiting on?","device":"phone"}'
```

## 7. Optional extras

- **Push alerts (Firebase):** in the Firebase console, add an Android app with package `com.sidekiqq.app`, then:
  - Download `google-services.json` to `android/phone/` (it is git-ignored).
  - Under **Project settings → Service accounts**, generate a key and paste the JSON (or its base64) into
    `FIREBASE_SERVICE_ACCOUNT_JSON` in Vercel.
- **Zoom:** see `brain/README.md` › Deploy step 8.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build: "JavaScript heap out of memory" | `npm run build` already sets `NODE_OPTIONS=--max-old-space-size=6144`. If Vercel's builder still runs out, use a larger build machine (Project → Settings → Build) or open an issue for the crew (backlog: build memory). |
| Deploy rejected over the cron schedule | You're on Hobby: see step 3.3. |
| Google: `redirect_uri_mismatch` | The URI in Google Cloud must match `APP_URL` + `/api/google/callback` exactly. Check `APP_URL`, then redeploy. |
| Google: "access blocked" / app not verified | Add yourself as a test user (step 4.3), or click Advanced → continue on the unverified-app screen. |
| Connections shows "needs reconnect" after a week | The Testing-mode 7-day expiry (step 4). Reconnect, or publish the app. |
| 503 "server not configured" | A required variable is missing. Compare with `brain/.env.example`, then redeploy. |
| Phone pairing: "invalid or expired code" | Codes are single use and last 10 minutes. Make a new one. Ten attempts per 15 minutes per IP. |
| `/api/ask` times out on long questions | Known (backlog: 60 s budget). Ask something shorter for now. |
