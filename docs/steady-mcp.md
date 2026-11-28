# Steady MCP

`POST /api/steady/mcp` is a streamable HTTP MCP endpoint for the Steady account. Send `Accept: application/json, text/event-stream` and `Authorization: Bearer`. The response is JSON, or one `event: message` frame when the client accepts only SSE. `GET` is 405.

The bearer is an OAuth access token or a personal access token. The app session token is not accepted. Tokens are SHA-256 hashes in `steady_*` tables, separate from ABBL.

## Discovery

Steady's issuer is `{origin}/api/steady`, so it does not replace ABBL's issuer at the origin root.

- `GET /.well-known/oauth-protected-resource/api/steady/mcp`
- `GET /.well-known/oauth-authorization-server/api/steady`
- `POST /api/steady/oauth/register`
- `GET` and `POST /api/steady/oauth/authorize` (the Steady passcode)
- `POST /api/steady/oauth/token` (`authorization_code` or `refresh_token`)

Access tokens last one hour. Refresh tokens last 30 days and rotate. PKCE S256 is required. There is no client secret.

## Tokens for the app

The signed-in app calls:

- `POST /api/steady/tokens` `{ "name" }` → `{ "token": { "id", "name", "token", "createdAt" } }`. `token` is shown once.
- `GET /api/steady/connections` → `{ "tokens", "connections" }` with `id`, `name`, `createdAt`, `lastUsedAt`.
- `DELETE /api/steady/tokens/:id` revokes a personal access token or an OAuth connection.

## Tools

`list_workouts` takes `date` or `start` and `end`. It returns `{ start, end, workouts }` with `id`, `name`, `date`, `startedAt`, `completedAt`, `source`.

`get_workout` takes `id` and returns `{ workout }` with `exercises` and `sets` (`weightLb`, `reps`, `durationSec`, `note`).

`log_workout` takes `date`, optional `time`, `name`, optional `dayId`, and `exercises`: `{ exerciseId, notes?, sets: [{ weightLb, reps, durationSec?, note?, rpe? }] }`. Strength sets need weight and reps. Cardio sets need `durationSec`. There is no RPE column; a numeric `rpe` is stored as the note when `note` is empty. The workout is marked `source: { kind: "ai", client }`.

`edit_workout` takes `id` and any of `name`, `date`, `time`, `dayId`, and `exercises`. Sending `exercises` replaces the exercise and set list.

`delete_workout` soft-deletes for 30 days. `restore_workout` puts it back. `list_deleted_workouts` lists them. Deleted workouts are left out of Steady's own history, today, and week.

`list_exercises` returns the catalog. `get_plan` takes `date` and returns `{ date, weekStart, days, workouts }`. Each planned exercise also includes `targetSets`, `targetWeightLb`, `targetReps`, `repsLabel`, `lastTime`, `lastWeightLb`, and `lastReps`.

`get_next_workout` takes an optional `date` (America/Boise today when omitted) and returns `{ workout }` with `date`, `weekStart`, `dayId`, `name`, `summary`, `sessionId`, `wrapped`, and `exercises`. Each exercise has `exerciseId`, `name`, `targetSets`, `targetWeightLb`, `targetReps`, `repsLabel`, `measure`, `perSide`, `isCardio`, `cardioMin`, `notes`, `lastTime`, `lastWeightLb`, and `lastReps`. The day is the in-progress session if one is open, otherwise the first program day not finished this week, otherwise the first day again next week (`wrapped: true`). `targetWeightLb` is the most recent logged weight, the same value a new session writes into every set. `targetReps` is the program rep count. `repsLabel` is the range the program shows, such as `6–8`. If that day already has an open session, the weight and reps are the next unlogged set's values, which is what the iOS fields are showing. `lastTime` is the same performance line the workout screen prints. Cardio has no weight or rep count; its target is `repsLabel`. This is the server prefill. It was not copied from the iOS app. Soft-deleted workouts are ignored when choosing the last weight.

`log_weight` takes `date`, `weightLb`, optional `unit` (`lb` only), and optional `note`. The same date replaces the weigh-in. `list_weights` takes `start` and `end` and returns `entries` plus `average`, `count`, `change`, and `hint` from the same 7-day average Steady shows. `edit_weight` and `delete_weight` take `id`.

Each token is limited to 60 MCP requests a minute. Rejected sign-ins are limited to 30 a minute per IP. Writes are audited with the action, target id, and client name. Workout names, set notes, and weight notes are not in the audit row.

`STEADY_PUBLIC_URL` is optional and not a secret. Set it to the public origin when discovery should advertise that host. If it is unset, `ABBL_PUBLIC_URL` is used, then the request host.

This API does not write to Loop, Nightscout, or HealthKit.
