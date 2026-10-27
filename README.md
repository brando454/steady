# Steady

Steady is a single-user phone app for logging workouts, meals, and body weight. It is an installable PWA. All times are America/Boise.

The lifting program is five full-body days, Monday through Friday. Targets start at 3,000 kcal, 190 g protein, 330 g carbs, and 85 g fat, and they can be changed in Settings. A return-to-training ramp shows a note for two weeks (about 70%, then about 85%). It does not change the weights for you.

Nothing in this repo is a secret. The repository may be public. Passcodes, API tokens, and third-party keys come from environment variables.

## Local setup

You need Node.js 22 or newer and Postgres 14 or newer.

```bash
npm install
cp .env.example .env
```

Create a database and put its URL in `.env`:

```bash
# example, matching docker-compose.yml
docker compose up -d
```

```text
DATABASE_URL=postgres://steady:steady@localhost:5432/steady
APP_PASSCODE=choose-a-passcode
COACH_API_TOKEN=choose-a-coach-token
WIDGET_TOKEN=choose-a-widget-token
```

`APP_PASSCODE` must be at least 4 characters. In production the app refuses the placeholders `change-me`, `steady-dev`, `password`, and `1234`.

```bash
npm run dev
```

The API listens on port 3000 and the phone UI on port 5173. Open http://localhost:5173. The first visit asks for the passcode and then stores a cookie for about a year.

`npm test` covers daily totals, PR detection, the Monday week reset, and the 7-day weight average. `npm run build && npm start` serves the production bundle from `dist/`.

On a laptop or in development, the first boot also inserts sample workouts, meals, and weigh-ins so the screens are not empty. A production boot (`NODE_ENV=production`) seeds the program, targets, and favorite meals only. Sample rows are marked and can be deleted in Settings. Set `SEED_SAMPLES=1` only if you deliberately want that demo history on a new production database. It is not recommended, because those sets become the baseline for personal records.

`STEADY_RESEED=1` wipes and reseeds a non-production database on the next boot. It does nothing when `NODE_ENV=production`.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string. |
| `APP_PASSCODE` | Yes | Unlocks the app once per device. |
| `COACH_API_TOKEN` | No | Bearer token for the coach read API. If unset, that route returns 503. |
| `WIDGET_TOKEN` | No | Bearer token for the home-screen widget. Separate from the coach token. If unset, that route returns 401. |
| `NIGHTSCOUT_URL` | No | Nightscout site. A trailing slash, `/api/v1`, or a pasted `?token=` query is ignored. If either Nightscout variable is missing, the glucose card is hidden and Settings says which one. |
| `NIGHTSCOUT_TOKEN` | No | Read token sent as the `token` query parameter. Steady uses this only for GET requests. |
| `NIGHTSCOUT_WRITE_TOKEN` | No | Optional access token for meal Notes. In Nightscout Admin Tools, create a subject with the `careportal` role and paste its access token here. Leave it unset to keep Nightscout read-only. |
| `AI_API_KEY` | No | Key for meal estimates. If unset, meals are entered by hand. |
| `AI_BASE_URL` | No | OpenAI-compatible API origin. Defaults to `https://api.openai.com/v1`. |
| `AI_MODEL` | No | Vision-capable chat model. Defaults to `gpt-4o-mini`. |
| `PORT` | No | HTTP port. Render sets this. Local default is 3000. |
| `NODE_ENV` | No | `production` on Render. Changes cookie security, passcode checks, and sample seeding. |
| `SEED_SAMPLES` | No | Set to `1` to insert demo history on an empty production database. |
| `STEADY_RESEED` | No | Set to `1` to wipe and reseed outside production. |

## Deploy on Render

1. Push this repo to GitHub.
2. In the Render dashboard, choose **New** → **Blueprint** and select the repo. Render reads `render.yaml`.
3. When Render prompts for the secret env vars (`sync: false`), set `APP_PASSCODE` and, if you want them, `COACH_API_TOKEN`, `WIDGET_TOKEN`, `NIGHTSCOUT_URL`, `NIGHTSCOUT_TOKEN`, `NIGHTSCOUT_WRITE_TOKEN`, and `AI_API_KEY`.
4. Apply the Blueprint. The web service builds with `npm install --include=dev && npm run build` (devDependencies are required for the Vite build) and starts with `npm start`. Render's health check is `GET /health`.

The web service and database are both in Oregon so they share a private network. `DATABASE_URL` is the internal connection string. The database allow list is empty, so it accepts connections from that private network only. To use `psql` from a laptop, add your IP on the database's Networking page.

To keep the app awake for a 5:30 AM workout, change the web service `plan` from `free` to `0.5c-512mb` in `render.yaml` (or in the dashboard). Paid instances do not spin down.

Add Steady to the home screen from the browser's share sheet. It uses a service worker, a manifest, and icons. The worker never caches `/api` or `/health`.

## Database cost and limits

Prices below are from Render's pricing and docs as of October 2026. Check [render.com/pricing](https://render.com/pricing) before you rely on them.

The Blueprint creates a **paid** Postgres instance, plan `0.1c-256mb` (legacy name `basic-256mb`):

- **$6 per month**, 0.1 CPU, 256 MB RAM, up to 100 connections.
- **1 GB** disk is included in the instance price (`diskSizeGB: 1`). Extra storage is **$0.30 per GB-month**. Disk size can be 1 GB or a multiple of 5 GB, and it can only grow.
- Paid databases include point-in-time recovery: the past **3 days** on a Hobby workspace, **7 days** on Pro and above. You can also export a logical backup, which Render keeps for 7 days.
- The instance does not expire.

A **free** Postgres instance is not what this Blueprint uses. It is $0, limited to 1 GB, allows only one free database per workspace, has no backups, may restart at any time, and **expires 30 days** after creation. There is a 14-day grace period to upgrade it. After that, Render deletes the database and the data.

The web service in the Blueprint is on the **free** plan: $0, 0.1 CPU, 512 MB RAM. It spins down after 15 minutes without traffic and takes about a minute to wake. Each workspace gets 750 free instance hours per month. A spun-down service does not use those hours. Render may restart a free web service at any time. The filesystem is ephemeral, which is fine because photos are stored as small JPEG data in Postgres, not on disk.

The always-on web plan `0.5c-512mb` (legacy name `starter`) is **$7 per month** for 0.5 CPU and 512 MB RAM.

## Coach read API

`GET /api/coach/review?from=YYYY-MM-DD&to=YYYY-MM-DD`

Send `Authorization: Bearer $COACH_API_TOKEN`. Dates are America/Boise civil dates, and the range can be at most 120 days. The JSON includes meals (no photos) with a glucose summary on each meal, daily totals against targets, workouts with sets, personal records, weigh-ins, and a glucose summary on each finished workout. Glucose values are mg/dL. An unfinished workout has `glucose: null`. A meal has `glucose: null` when Nightscout is not configured.

```bash
curl -sS \
  -H "Authorization: Bearer $COACH_API_TOKEN" \
  "https://YOUR-SERVICE.onrender.com/api/coach/review?from=2026-10-19&to=2026-10-25"
```

A missing or wrong token is 401. Repeated failures are rate limited. If `COACH_API_TOKEN` is unset, the route is 503.

## Home-screen widget

`GET /api/widget/today`

Read-only totals for today in America/Boise, the same eaten and target numbers as the Today screen. Send `Authorization: Bearer $WIDGET_TOKEN`, or `?token=` if a header is awkward. The response is `Cache-Control: no-store`. A missing or wrong token is 401, including when `WIDGET_TOKEN` is unset. Repeated failures are rate limited. This token is not the coach token.

```bash
curl -sS \
  -H "Authorization: Bearer $WIDGET_TOKEN" \
  "https://YOUR-SERVICE.onrender.com/api/widget/today"
```

```json
{
  "date": "2026-10-25",
  "updatedAt": "2026-10-25T15:04:00.000Z",
  "calories": { "eaten": 1000, "target": 3000, "left": 2000 },
  "protein": { "eaten": 80, "target": 190 },
  "carbs": { "eaten": 100, "target": 330 },
  "fat": { "eaten": 30, "target": 85 }
}
```

`widgets/steady-widget.js` is a Scriptable script for a small or medium home-screen widget. Paste `WIDGET_TOKEN` into `TOKEN` at the top. A tap opens the Food tab at `https://steady-re7n.onrender.com/food`. The app uses the URL path, not a hash, so `/food` is the Food tab and `/#/food` is not.

## Glucose

If `NIGHTSCOUT_URL` and `NIGHTSCOUT_TOKEN` are set, the workout screen reads the latest sensor glucose about once a minute:

```text
GET {NIGHTSCOUT_URL}/api/v1/entries.json?token=...&count=1
```

That request is a GET. Sensor entries are never written back, and Steady never writes to Loop or HealthKit. If Nightscout is not configured or cannot be reached, the glucose card is hidden and Settings says why. A reading older than 15 minutes still shows, marked as older than 15 minutes. The card is a reading and a trend only. Under about 120 mg/dL, and only while cardio is still ahead, it adds one line: have a low snack handy. It does not suggest insulin doses. Carbs for a meal are shown so they can be typed into Loop by hand.

A finished workout also reads the sensor glucose from the start of the session through two hours after it ends. That is another GET, for the entries in that window. The session screen and the Day done card show the value at the start, at the end, the average and lowest during the workout, and the lowest in the two hours after. The two-hour low uses the same amber and red as the live glucose pill: under 120, and over 180. A small sparkline covers the whole window, with the workout itself shaded, and breaks where readings are more than about 12 minutes apart. While those two hours are still open, the summary says it is in progress and fills in as readings arrive. Once the window closes, Steady stores the summary on the session so it remains if Nightscout later drops the old entries. A failed read is not stored. Missing readings stay blank.

A logged meal gets the same kind of summary, on a three-hour window. The Food list keeps it on one line until you tap it: the reading at the meal, the peak and how many minutes later it was, the rise, and the lowest reading in those three hours. The sparkline starts 30 minutes before the meal and runs to three hours after, with a mark at the meal time. While those three hours are still open it says in progress. Once they close, Steady stores the summary on the meal. The Food tab also draws that day's sensor glucose, from midnight through now on the current day, with a small mark for each meal and workout. Tapping a meal mark shows its name and macros. The day totals sit above the log form.

If `NIGHTSCOUT_WRITE_TOKEN` is set, logging a meal also posts one Nightscout treatment. The server does that. The phone never calls Nightscout. The treatment is only a Note:

```json
{
  "eventType": "Note",
  "created_at": "2026-10-26T18:30:00.000Z",
  "enteredBy": "Steady",
  "notes": "Chicken bowl · 22C 10P 15F · 450 cal"
}
```

`created_at` is the meal time. The macros are rounded and live only inside `notes` (`C` carbs, `P` protein, `F` fat, `cal` calories). The body never includes `carbs`, `protein`, `fat`, `insulin`, `absorptionTime`, or any other dosing field, so it does not change Nightscout COB or IOB and it does not reach Loop. Editing the meal updates that note. Deleting the meal deletes it. The returned `_id` is stored on the meal. If the token is missing or Nightscout does not answer, the meal still saves, and Steady tries the note again later. An offline iPhone keeps the meal in its upload queue; the note is posted when that upload reaches the server. Create the token in Nightscout under Admin Tools → Subjects, with the `careportal` role, and put the subject's access token in `NIGHTSCOUT_WRITE_TOKEN`. The read token stays `NIGHTSCOUT_TOKEN`.

## Meal estimates

`POST /api/meals/estimate` sends the note and an optional image to `{AI_BASE_URL}/chat/completions` using `AI_MODEL`. The reply is parsed into a name plus calories, protein, carbs, and fat. Those four fields stay editable before the meal is saved. Without `AI_API_KEY`, the same form works by hand.

Photos that are kept are compressed JPEG thumbnails. Favorites do not store a photo. The coach API does not return photos.

The iPhone Food tab does the same. Take a photo or choose one, preview it, and remove it if it is wrong. Estimate fills the editable meal from the photo and the note. The phone sends a 1024 pixel JPEG for that estimate and keeps a smaller one, at most 120,000 characters, or leaves the picture off the saved meal if it still will not fit. Offline, Estimate says to enter the meal by hand. Log meal still saves it on the phone, photo included, until it can upload.

## Program

Days A through E live in `src/shared/program.ts`, with substitutes for the same muscles and movement pattern. On a workout you can swap an exercise for today or make the swap the new default. History stays with the exercise that was actually logged. Cardio is logged with minutes and an optional note.

The week resets every Monday. Any day can be started in any order. The next day that is not finished is the suggestion. A day left unfinished does not carry into the next week.

A personal record is a heavier weight at the same reps, or a higher estimated one-rep max (Epley). The first logged set of an exercise is not a record. Bodyweight work compares reps.

## Access

The passcode is checked once. A valid login sets an HttpOnly cookie (`steady_session`) for about a year, `SameSite=Lax`, and `Secure` in production. Logging out, or "Forget this phone" in Settings, clears it. The coach token and the widget token cannot be used as that cookie, and the cookie cannot call those APIs.

## iPhone

The native app is in `ios/`. It talks to the same Render service, keeps the passcode in the Keychain, and can log a workout while the gym has no signal. The phone does not write to Nightscout, Loop, or HealthKit. Meal Notes, when `NIGHTSCOUT_WRITE_TOKEN` is set, are posted by the server after the phone uploads the meal. A finished workout shows the same glucose summary as the phone site once the server sends it: start, end, average, lowest during, and the lowest in the two hours after, plus a small sparkline. A logged meal shows the three-hour meal summary, and the Food tab shows the day graph. mg/dL only.

The home-screen widget is small and medium. A tap opens Food (`steady://food`). The rest timer can show a Live Activity and plays one short ding when rest ends. With the app open, that ding is paired with one success haptic. On the lock screen, the notification plays the same ding and vibrates according to the phone's settings.

### One-time Apple and GitHub setup

1. Enroll in the Apple Developer Program.
2. Register two App IDs: `com.brando454.steady` and `com.brando454.steady.widget`. Turn on App Groups for both.
3. Create the App Group `group.com.brando454.steady` and add it to both IDs.
4. In App Store Connect, create the app Steady with bundle ID `com.brando454.steady`. Pick any SKU.
5. Create an App Store Connect API key with Admin access. Save the Key ID, the Issuer ID, and the `.p8` file. The `.p8` downloads once. Base64-encode that file for the secret below.
6. Create an Apple Distribution certificate, export it as a `.p12` with a password, and base64-encode the `.p12`.

Add these GitHub Actions secrets on the repository. The names are the whole secret. Put the values in GitHub, not in the repo.

| Secret | Value |
| --- | --- |
| `APP_STORE_CONNECT_KEY_ID` | API key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID |
| `APP_STORE_CONNECT_KEY_P8` | Base64 of the `.p8` file |
| `APPLE_TEAM_ID` | Team ID |
| `IOS_DISTRIBUTION_P12_BASE64` | Base64 of the distribution `.p12` |
| `IOS_DISTRIBUTION_P12_PASSWORD` | Password for that `.p12` |

`.github/workflows/ios-testflight.yml` runs on every push to `main`, and when you start it by hand. It always compiles with signing turned off. The build number is the GitHub run number. If the six secrets are set, it archives with automatic signing and uploads to TestFlight. A push that does not have the secrets still compiles and does not upload. Starting the workflow by hand without the secrets fails, so a missing secret is obvious.

The week still resets on Monday. The server stays on Render.
