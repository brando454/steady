# ABBL API

Nutrition-only API for the ABBL iPhone app. It is served by Steady's Express server and Postgres database, under `/api/abbl/v1`. Steady's passcode, workouts, meals, and Nightscout writes are unchanged.

Every ABBL response is JSON. Errors are `{ "error": "..." }`.

The caller sends `Authorization: Bearer <token>` on every route except `POST /auth/redeem`.

Dates are the phone's civil date, `YYYY-MM-DD`. Times are `HH:mm`. They are not America/Boise dates.

## Nutrients

```json
{ "kcal": 200, "protein_g": 10, "carbs_g": 30, "fat_g": 4, "fiber_g": null }
```

`fiber_g: null` means the source did not list fiber. It is never stored or treated as 0. A listed 0 stays 0.

Totals add a flag:

```json
{ "kcal": 200, "protein_g": 10, "carbs_g": 30, "fat_g": 4, "fiber_g": null, "fiber_unknown": true }
```

- Every item's fiber is known: `fiber_unknown` is false and `fiber_g` is the sum.
- Some items are unknown: `fiber_unknown` is true and `fiber_g` is the sum of the known values only.
- Every item is unknown: `fiber_unknown` is true and `fiber_g` is null.

On a recipe or logged item, `nutrients` are the amounts for that ingredient's `grams`, not per 100 g. Food search is the exception: it returns both `per100g` and `perServing`.

Photos are not stored. Request logs do not include meal names, notes, ingredient text, codes, or photos. Nothing in this API writes to Nightscout.

## Auth

There is no email and no password. Sign-in is `POST /auth/redeem` with `{ "code", "name"? }`. It is rate-limited per IP. A wrong, expired, revoked, or already-used code is `401`. Too many tries is `429`.

The admin bootstraps with `ABBL_ADMIN_SETUP_CODE`, a secret Brandon sets in Render. Redeeming that code creates the admin, or signs the same admin in again. `name` is optional. The first time it is omitted, the name is `Admin`. A later redeem with `name` renames the admin. The setup code stays valid.

Everyone else redeems a single-use invite code. The response is:

```json
{ "token": "<long-lived bearer>", "user": { "id": "...", "name": "Kate", "email": null, "admin": false } }
```

`email` is null when nobody set one. The token is stored only as a hash. It lasts until logout or until an admin removes the user. A valid invite for a disabled account is `403`, and that invite is already spent.

`POST /auth/logout` revokes the current token. `GET /me` returns `{ "user": { ... } }`.

## Admin

Only the account created with the setup code has `admin: true`.

- `POST /admin/invites` with `{ "name", "email"? }` creates one invite. The code looks like `ABCD-EFGH-JKM2`: three groups of four characters, with no `0`, `O`, `1`, `I`, or `L`. It is valid for 7 days and works once. The response includes `code` once. The database stores only a hash.
- `GET /admin/invites` returns `{ "invites", "users" }`. Invites are `{ id, name, email, userId, status, expiresAt, createdAt }` with status `pending`, `used`, `revoked`, or `expired`. Users are `{ id, name, email, admin, disabled }`. Neither list includes a code.
- `DELETE /admin/invites/:id` revokes an unused code. A used code is `404`.
- `DELETE /admin/users/:id` disables that user and revokes their tokens. Their recipes and meals stay. The admin cannot remove their own account.
- `POST /admin/users/:id/invite` issues a new one-time code that signs that same user in on another phone. A disabled account cannot be invited.

## Targets

`GET /targets` returns `{ "targets": null }` until they are saved.

`PUT /targets` with `{ "kcal", "protein_g", "carbs_g", "fat_g", "fiber_g" }` saves them. The fiber target is a number, not null.

`POST /targets/suggest` does not save. Body:

```json
{ "sex": "female", "age": 34, "heightCm": 168, "weightKg": 64, "activity": "mostly seated", "goal": "maintain" }
```

Activity is `mostly seated` (1.2), `on my feet` (1.375), `active` (1.55), or `very active` (1.725). Goal is `maintain` (no change), `lose gently` (−250 kcal, 2.0 g protein per kg), or `build muscle` (+250 kcal, 2.2 g protein per kg). Maintain uses 1.8 g protein per kg.

Calories are Mifflin–St Jeor BMR times the activity factor, plus the goal adjustment, and at least 1000. Fat is 30% of those calories. Carbs fill the rest. Fiber is 14 g per 1000 kcal.

## Food lookup

Keys stay on the server.

- `GET /foods/search?q=` uses USDA FoodData Central. Missing `USDA_API_KEY` is `503` on this route only.
- `GET /foods/barcode/:upc` searches USDA branded foods, then Open Food Facts. Missing `USDA_API_KEY` is `503` for this route too. No match is `404`.
- `GET /restaurants/search?q=` uses Spoonacular menu items. Missing `SPOONACULAR_API_KEY` is `503` on this route only.

A hit looks like:

```json
{
  "id": "usda:173944",
  "name": "Bananas, raw",
  "source": "usda",
  "per100g": { "kcal": 89, "protein_g": 1.1, "carbs_g": 22.8, "fat_g": 0.3, "fiber_g": 2.6 },
  "serving": { "label": "1 medium", "grams": 118 },
  "perServing": { "kcal": 105, "protein_g": 1.3, "carbs_g": 26.9, "fat_g": 0.4, "fiber_g": 3.1 }
}
```

`source` is `usda`, `open_food_facts`, or `spoonacular`. Restaurant hits also include `restaurant`. `per100g` or `perServing` is null when the source has no gram weight to convert. Missing fiber stays null.

USDA hits also include `servings`: a list of `{ "label", "grams", "quantity", "unit" }`. `unit` is `g`, `oz`, `cup`, `tbsp`, `tsp`, `piece`, or null. `quantity` is the count in that unit. A tablespoon or a piece is included when the USDA household text or `foodMeasures` / `foodPortions` has a gram weight. `serving` remains the primary household serving for older clients.

## AI

These routes use the same `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` settings as Steady's meal estimate. If the key is missing, the route returns `503` and Steady's own estimate route is unchanged.

`POST /estimate` accepts up to 6 base64 JPEGs, with or without a `data:image/jpeg;base64,` prefix, plus an optional `note`. The body limit on this route only is 32 MB. Nothing is saved. The same route re-estimates one item: send `target` (`{ "name", "grams"? }`) and/or `correction` (a short string). Photos may be omitted for that correction. The response is still `{ "ingredients": [...] }`, limited to that item. There is no separate re-estimate endpoint.

```json
{ "photos": ["<base64 jpeg>"], "note": "olive oil on top" }
```

```json
{ "photos": ["<base64 jpeg>"], "target": { "name": "chicken", "grams": 180 }, "correction": "that was tofu, not chicken" }
```

Response: `{ "ingredients": [{ "photoIndex", "name", "grams", "nutrients", "confidence" }] }`. One photo may return several ingredients. `photoIndex` says which photo each one came from. `confidence` is 0 to 1. Nutrients are for `grams`.

`uncertainty` is optional, 0 to 1, and only present when the model reported how unsure the portion is. `nutrients` is null, and `nutrition_missing` is `true`, when the portion could not be given real calories and macros. That happens when the model sends all-zero calories, protein, carbs, and fat, and neither a per-100 g estimate nor USDA can fill them. A known zero fiber stays `0`. A missing fiber stays `null`. USDA fiber is not turned into 0. All-zero calories and macros are never returned as if they were a real estimate.

`POST /label-scan` with `{ "photo" }` returns `{ "servingSize", "servingsPerContainer", "nutrients" }` per serving. Each nutrient may be null when that line could not be read. One unreadable line does not fail the scan. The scan fails only when every nutrient is unreadable. `fiber_g` is null when fiber is missing, and 0 when the label says 0. `"<1"` (with or without a unit such as `g`) is read as 0.5. `"<0.5"` and `"trace"` are 0. Any other `"<N"` is `N/2`. A trailing `mg` is converted to grams. `g`, `kcal`, and `cal` are stripped.

`POST /recipe-helper` with `{ "description", "messages"? }` returns `{ "ingredients": [{ "name", "grams", "nutrients", "source" }], "questions": ["..."] }`. The same nutrition rule applies: all-zero calories and macros are filled from USDA, or `nutrients` is null and `nutrition_missing` is `true`. `source` is `usda` when the server filled the numbers that way. `uncertainty` is optional, the same as on a photo estimate. Nothing is saved until the app posts a recipe. `messages` is an optional list of `{ "role": "user" | "assistant", "content" }`.

## Recipes

`GET /recipes` and `POST /recipes`. `GET`, `PUT`, and `DELETE /recipes/:id`.

```json
{
  "name": "Chicken pan",
  "servings": 4,
  "yieldGrams": 1300,
  "notes": "optional",
  "ingredients": [
    { "name": "Chicken broth", "quantity": 3.5, "unit": "cup", "grams": 840, "source": "ai", "nutrients": { "kcal": 59, "protein_g": 4, "carbs_g": 5, "fat_g": 1.7, "fiber_g": 0 } }
  ]
}
```

Each ingredient may include `quantity` and `unit`. `unit` is `g`, `oz`, `cup`, `tbsp`, `tsp`, `piece`, or null. `quantity` is a number greater than 0, or null when the ingredient only has a gram amount. Older rows come back with both set to null. `grams` is what the nutrients describe. Logging a portion scales `quantity` by the same factor as `grams` and leaves a null quantity null. The unit stays as it was. A bad unit or quantity is `400`. Omitting both fields is the same as sending null.

The response adds `totals` and `perServing`. `perServing` divides those totals by `servings`.

`POST /recipes/:id/share` takes exactly one of:

- `{ "toUserId" }`, which copies the recipe onto that ABBL account. Later edits do not change the copy.
- `{ "toSteady": true }`, admin only. Copies one per-serving entry into Steady's saved meals (`favorites`). Steady favorites have no fiber column, so fiber is left off that copy. The note is empty.

## Log

`GET /days/:date` returns `{ "date", "targets", "meals", "totals" }`.

`POST /meals` and `PUT /meals/:id` take either items or a recipe, plus `date`, `time`, and an optional `meal`. `date` is any real civil date from `2000-01-01` through the day after the server clock, so a past day is logged the same way as today. `PUT` changes the date, the time, and the meal type. `meal` is `breakfast`, `lunch`, `snack`, `dinner`, or null. Optional `name` and `note` are stored on the meal. Optional `source` is `{ "kind": "app" | "ai", "client": string | null }`. On `POST`, omitted source is `{ "kind": "app", "client": null }`. On `PUT`, omitted `name`, `note`, and `source` stay as they were stored, so an AI meal keeps `{ "kind": "ai", "client" }`. Send `source` to replace it. `{ "kind": "app", "client": null }` is how the app marks a meal it edited. Apple Health is updated on the phone, not by this API.

```json
{ "date": "2024-03-02", "time": "12:30", "meal": "lunch", "items": [ { "name": "Olive oil", "quantity": 1, "unit": "tbsp", "grams": 14, "edited": true, "foodRef": "usda:171413", "source": "usda", "nutrients": { "kcal": 119, "protein_g": 0, "carbs_g": 0, "fat_g": 13.5, "fiber_g": 0 } } ] }
```

```json
{ "date": "2026-11-14", "time": "18:00", "recipeId": "...", "servings": 1 }
```

```json
{ "date": "2026-11-14", "time": "18:00", "recipeId": "...", "grams": 325 }
```

`servings` scales by `servings / recipe.servings`. `grams` scales by `grams / yieldGrams`, and is rejected when the recipe has no cooked weight. A saved `quantity` scales by that same factor. A logged item may include `edited` and `foodRef`. `edited: true` means the client supplied the nutrients, and the server stores them without recomputing. `foodRef` is the USDA or barcode id when the food was swapped. Both are optional; older rows come back with `edited: false` and `foodRef: null`. The logged items are a snapshot, so later recipe edits do not change the day.

Each item's `nutrients.fiber_g` is null when fiber is unknown and a number when it is known, including 0. Meal `totals` and day `totals` use the same rule and add `fiber_unknown`. A totals-only meal item may have `grams: null` on `POST /meals` and `PUT /meals/:id`. The nutrients are stored as sent and are not scaled from grams. `grams: 0`, a negative number, or an unreadable amount is still `400` with `grams looks off`. Recipe ingredients still require a gram weight.

`DELETE /meals/:id` soft-deletes the meal. It leaves day lists and totals immediately. `GET /meals/deleted` returns `{ "meals": [ ...meal, "deletedAt" ] }` for meals deleted in the last 30 days. `POST /meals/:id/restore` puts one back. After 30 days the row is purged.

Meal names and notes are stored on the meal. They are not written to server logs, the audit log, photos, or Nightscout.

Queries always include the caller's `user_id`. One account cannot read or change another's recipes, meals, or targets.

## Connections

The signed-in app creates a personal access token with `POST /tokens` and `{ "name" }`. The response is `{ "token": { "id", "name", "token", "createdAt" } }`. `token` is shown once. It is stored only as a SHA-256 hash.

`GET /connections` returns `{ "tokens": [{ "id", "name", "createdAt", "lastUsedAt" }], "connections": [{ "id", "name", "createdAt", "lastUsedAt" }] }`. `tokens` are personal access tokens. `connections` are OAuth clients that finished sign-in. `DELETE /tokens/:id` revokes either kind. A revoked token cannot call MCP. Disabling a user revokes both.

## MCP

`POST /api/abbl/mcp` is a streamable HTTP MCP endpoint. The body is one JSON-RPC 2.0 message. Send `Accept: application/json, text/event-stream`. A normal response is `application/json`. If the client accepts only `text/event-stream`, the same JSON-RPC message comes back as one `event: message` SSE frame. `GET` is `405` because the server does not push messages. Send `Authorization: Bearer` with a personal access token or an OAuth access token. A session token from `POST /auth/redeem` is not an MCP token.

Discovery:

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/api/abbl/mcp`
- `GET /.well-known/oauth-authorization-server`

OAuth is authorization code with PKCE S256. There is no client secret.

- `POST /api/abbl/oauth/register` with `{ "client_name", "redirect_uris", "token_endpoint_auth_method": "none" }`
- `GET /api/abbl/oauth/authorize` shows an invite-code sign-in
- `POST /api/abbl/oauth/token` accepts `application/x-www-form-urlencoded` `authorization_code` or `refresh_token`

Access tokens last one hour. Refresh tokens last 30 days and rotate. The authorize form signs in with the same invite code as `POST /auth/redeem`, including the admin setup code.

Tools: `log_meal`, `edit_meal`, `delete_meal`, `list_meals`, `get_totals`.

`log_meal` and `edit_meal` take `date`, optional `time` (`HH:mm`), optional `meal`, optional `name`, optional `note`, and either `items` or `totals` (`kcal`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g`). `edit_meal` also takes `id`. Dates use the same rule as `POST /meals`. MCP writes set `source` to `{ "kind": "ai", "client": "<token or OAuth client name>" }`.

`list_meals` takes `date` and returns `{ "date", "meals", "totals" }`. `get_totals` takes `date` or `start` and `end` and returns `{ "start", "end", "days": [{ "date", "totals" }], "totals" }`. Totals include `fiber_g` and `fiber_unknown`.

Each signed-in user is limited to 60 MCP requests a minute. Rejected sign-ins are limited to 30 a minute per IP. A write (`log_meal`, `edit_meal`, `delete_meal`) adds an audit row with the user, action, meal id, and client name. The meal name and note are not in that row.

Set `ABBL_PUBLIC_URL` to the public origin, such as `https://steady.example.com`, when the request host is not the URL clients use. If it is unset, the server uses the forwarded protocol and host. This value is not a secret. The API does not write to Loop, Nightscout, or HealthKit.
