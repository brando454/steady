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
| `NIGHTSCOUT_URL` | No | Nightscout site origin, no path. If either Nightscout variable is missing, the glucose card is hidden. |
| `NIGHTSCOUT_TOKEN` | No | Read token sent as the `token` query parameter. |
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
3. When Render prompts for the secret env vars (`sync: false`), set `APP_PASSCODE` and, if you want them, `COACH_API_TOKEN`, `NIGHTSCOUT_URL`, `NIGHTSCOUT_TOKEN`, and `AI_API_KEY`.
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

Send `Authorization: Bearer $COACH_API_TOKEN`. Dates are America/Boise civil dates, and the range can be at most 120 days. The JSON includes meals (no photos), daily totals against targets, workouts with sets, personal records, and weigh-ins. It does not include glucose.

```bash
curl -sS \
  -H "Authorization: Bearer $COACH_API_TOKEN" \
  "https://YOUR-SERVICE.onrender.com/api/coach/review?from=2026-10-19&to=2026-10-25"
```

A missing or wrong token is 401. Repeated failures are rate limited. If `COACH_API_TOKEN` is unset, the route is 503.

## Glucose

If `NIGHTSCOUT_URL` and `NIGHTSCOUT_TOKEN` are set, the workout screen reads the latest sensor glucose about once a minute:

```text
GET {NIGHTSCOUT_URL}/api/v1/entries.json?token=...&count=1
```

That request is a GET. Steady never writes to Nightscout or to Loop. If Nightscout is not configured or cannot be reached, the glucose card is hidden. The card is a reading and a trend only. Under about 120 mg/dL, and only while cardio is still ahead, it adds one line: have a low snack handy. It does not suggest insulin doses. Carbs for a meal are shown so they can be typed into Loop by hand.

## Meal estimates

`POST /api/meals/estimate` sends the note and an optional image to `{AI_BASE_URL}/chat/completions` using `AI_MODEL`. The reply is parsed into a name plus calories, protein, carbs, and fat. Those four fields stay editable before the meal is saved. Without `AI_API_KEY`, the same form works by hand.

Photos that are kept are compressed JPEG thumbnails. Favorites do not store a photo. The coach API does not return photos.

## Program

Days A through E live in `src/shared/program.ts`, with substitutes for the same muscles and movement pattern. On a workout you can swap an exercise for today or make the swap the new default. History stays with the exercise that was actually logged. Cardio is logged with minutes and an optional note.

The week resets every Monday. Any day can be started in any order. The next day that is not finished is the suggestion. A day left unfinished does not carry into the next week.

A personal record is a heavier weight at the same reps, or a higher estimated one-rep max (Epley). The first logged set of an exercise is not a record. Bodyweight work compares reps.

## Access

The passcode is checked once. A valid login sets an HttpOnly cookie (`steady_session`) for about a year, `SameSite=Lax`, and `Secure` in production. Logging out, or "Forget this phone" in Settings, clears it. The coach token cannot be used as that cookie, and the cookie cannot call the coach API.
