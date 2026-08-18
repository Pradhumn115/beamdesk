import { test } from "node:test";
import assert from "node:assert/strict";
import { StuckBacklogDetector } from "./stuckbacklog.js";

/** Feeds `count` readings and returns whether the last one was trusted. */
function feed(d: StuckBacklogDetector, bytes: number, count: number): boolean {
  let trusted = true;
  for (let i = 0; i < count; i++) trusted = d.trust(bytes);
  return trusted;
}

test("a queue that moves is believed", () => {
  const d = new StuckBacklogDetector();
  for (let i = 0; i < 500; i++) {
    assert.equal(d.trust(100_000 + (i % 7) * 1024), true);
  }
});

/**
 * The failure this guards: a stranded write left 633KB counted as outstanding
 * for an entire session, so every frame was skipped as undeliverable while the
 * link sat idle.
 */
test("a depth frozen to the byte is eventually distrusted", () => {
  const d = new StuckBacklogDetector();
  // Patient at first: a burst can hold a queue steady for a moment.
  assert.equal(feed(d, 633 * 1024, 30), true, "not too eager");
  // But a value that never moves at all is not a queue.
  assert.equal(feed(d, 633 * 1024, 200), false, "it does give up");
});

test("zero is never treated as stuck", () => {
  const d = new StuckBacklogDetector();
  assert.equal(feed(d, 0, 5000), true, "an idle transport is not a bug");
});

test("a single changed reading restores trust", () => {
  const d = new StuckBacklogDetector();
  feed(d, 633 * 1024, 200);
  assert.equal(d.trust(633 * 1024), false, "precondition: distrusted");
  assert.equal(d.trust(600 * 1024), true, "it moved, so it is a queue again");
  assert.equal(d.trust(600 * 1024), true);
});

test("reports once per episode, not once per reading", () => {
  const d = new StuckBacklogDetector();
  feed(d, 500_000, 95);
  assert.equal(d.shouldReport(), true);
  assert.equal(d.shouldReport(), false, "must not repeat on every frame");
  // A new episode after recovery reports again.
  d.trust(400_000);
  feed(d, 400_000, 95);
  assert.equal(d.shouldReport(), true);
});

test("says nothing while the reading is still plausible", () => {
  const d = new StuckBacklogDetector();
  feed(d, 500_000, 10);
  assert.equal(d.shouldReport(), false);
});
