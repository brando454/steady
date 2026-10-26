import assert from "node:assert/strict";
import test from "node:test";
import { armRestore, dropScroll, jumpedToTop, noteScroll, restoreArmed, revealDelta, scrollKey, shouldRevealCurrentSet } from "../src/client/scroll";

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

test("logging stays put, and only the first look at a session reveals the active set", () => {
  assert.equal(shouldRevealCurrentSet(false, false), true);
  assert.equal(shouldRevealCurrentSet(true, false), false);
  assert.equal(shouldRevealCurrentSet(false, true), false);
  assert.equal(shouldRevealCurrentSet(true, true), false);
});

test("a jump back to the top is not a small scroll", () => {
  assert.equal(jumpedToTop(640, 0), true);
  assert.equal(jumpedToTop(640, 100), true);
  assert.equal(jumpedToTop(640, 500), false);
  assert.equal(jumpedToTop(40, 0), false);
  assert.equal(jumpedToTop(200, 180), false);
});

test("revealing a set only nudges the scroller when the row is outside it", () => {
  assert.equal(revealDelta({ mainTop: 0, mainBottom: 700, nodeTop: 200, nodeBottom: 260, bottomMargin: 154 }), 0);
  assert.equal(revealDelta({ mainTop: 0, mainBottom: 700, nodeTop: -40, nodeBottom: 20, topGap: 8 }), -48);
  assert.equal(revealDelta({ mainTop: 0, mainBottom: 700, nodeTop: 680, nodeBottom: 740, bottomMargin: 154 }), 194);
});
