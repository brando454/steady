import { createApp } from "./app";
import { pool } from "./db";
import { migrate } from "./schema";
import { seedIfEmpty } from "./seed";
import { safeError } from "./util";

const passcode = process.env.APP_PASSCODE ?? "";
if (passcode.length < 4) {
  console.error("APP_PASSCODE must be set to at least 4 characters.");
  process.exit(1);
}
if (
  process.env.NODE_ENV === "production" &&
  ["change-me", "steady-dev", "password", "1234"].includes(passcode)
) {
  console.error("Refusing a placeholder APP_PASSCODE in production.");
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);
const app = createApp(passcode);

migrate()
  .then(() => seedIfEmpty())
  .then(() => {
    app.listen(port, "0.0.0.0", () => {
      console.log(`Steady listening on ${port}`);
    });
  })
  .catch(async (error: unknown) => {
    console.error(safeError(error));
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
