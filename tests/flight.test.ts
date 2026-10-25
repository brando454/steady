import assert from "node:assert/strict";
import test from "node:test";
import { createFlightGuard } from "../src/shared/flight";

test("a flight guard allows one request at a time", async () => {
  const guard = createFlightGuard();
  let calls = 0;

  async function run() {
    if (!guard.tryStart()) return;
    try {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      guard.finish();
    }
  }

  await Promise.all([run(), run(), run()]);
  assert.equal(calls, 1);
  await run();
  assert.equal(calls, 2);
});
