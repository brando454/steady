import assert from "node:assert/strict";
import test from "node:test";
import { armRestore, dropScroll, noteScroll, restoreArmed, scrollKey } from "../src/client/scroll";

test("session scroll is keyed by path and restored only on the way back", () => {
  dropScroll("/workout/session/abc");
  dropScroll("/workout");
  assert.equal(scrollKey("/workout/session/abc?from=1"), "/workout/session/abc");
  assert.equal(armRestore("/workout/session/abc"), false);

  noteScroll("/workout/session/abc?x=1", 640, "sx-1");
  assert.equal(restoreArmed("/workout/session/abc"), false);
  assert.equal(armRestore("/workout/session/abc"), true);
  assert.equal(restoreArmed("/workout/session/abc"), true);

  noteScroll("/workout", 220, "history");
  dropScroll("/workout/session/abc");
  assert.equal(restoreArmed("/workout/session/abc"), false);
  assert.equal(armRestore("/workout"), true);
  dropScroll("/workout");
  assert.equal(armRestore("/workout"), false);
});
