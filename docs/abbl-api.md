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

## AI

These routes use the same `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL` settings as Steady's meal estimate. If the key is missing, the route returns `503` and Steady's own estimate route is unchanged.

`POST /estimate` accepts up to 6 base64 JPEGs, with or without a `data:image/jpeg;base64,` prefix, plus an optional `note`. The body limit on this route only is 32 MB. Nothing is saved.

```json
{ "photos": ["<base64 jpeg>"], "note": "olive oil on top" }
```

Response: `{ "ingredients": [{ "photoIndex": 0, "name", "grams", "nutrients", "confidence" }] }`. At most one ingredient per photo. `confidence` is 0 to 1. Nutrients are for `grams`.

`POST /label-scan` with `{ "photo" }` returns `{ "servingSize", "servingsPerContainer", "nutrients" }` per serving.

`POST /recipe-helper` with `{ "description", "messages"? }` returns `{ "ingredients": [{ "name", "grams", "nutrients", "source" }], "questions": ["..."] }`. Nothing is saved until the app posts a recipe. `messages` is an optional list of `{ "role": "user" | "assistant", "content" }`.

## Recipes

`GET /recipes` and `POST /recipes`. `GET`, `PUT`, and `DELETE /recipes/:id`.

```json
{
  "name": "Chicken pan",
  "servings": 4,
  "yieldGrams": 1300,
  "notes": "optional",
  "ingredients": [
    { "name": "Chicken breast", "grams": 600, "source": "usda", "nutrients": { "kcal": 660, "protein_g": 138, "carbs_g": 0, "fat_g": 7.2, "fiber_g": 0 } }
  ]
}
```

The response adds `totals` and `perServing`. `perServing` divides those totals by `servings`.

`POST /recipes/:id/share` takes exactly one of:

- `{ "toUserId" }`, which copies the recipe onto that ABBL account. Later edits do not change the copy.
- `{ "toSteady": true }`, admin only. Copies one per-serving entry into Steady's saved meals (`favorites`). Steady favorites have no fiber column, so fiber is left off that copy. The note is empty.

## Log

`GET /days/:date` returns `{ "date", "targets", "meals", "totals" }`.

`POST /meals` and `PUT /meals/:id` take either items or a recipe, plus `date` and `time`:

```json
{ "date": "2026-11-14", "time": "12:30", "items": [ { "name": "Oats", "grams": 40, "source": "manual", "nutrients": { "kcal": 150, "protein_g": 5, "carbs_g": 27, "fat_g": 3, "fiber_g": null } } ] }
```

```json
{ "date": "2026-11-14", "time": "18:00", "recipeId": "...", "servings": 1 }
```

```json
{ "date": "2026-11-14", "time": "18:00", "recipeId": "...", "grams": 325 }
```

`servings` scales by `servings / recipe.servings`. `grams` scales by `grams / yieldGrams`, and is rejected when the recipe has no cooked weight. The logged items are a snapshot, so later recipe edits do not change the day. `DELETE /meals/:id` removes that meal.

A meal has no separate name or note. Item names are stored so the day can be shown again. They are not written to server logs, photos, or Nightscout.

Queries always include the caller's `user_id`. One account cannot read or change another's recipes, meals, or targets.
