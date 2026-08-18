import { test } from "node:test";
import assert from "node:assert/strict";
import { TrendlineEstimator, type ArrivalSample } from "./trendline.js";

/** Frames sent every `periodMs`, arriving with the given extra delays. */
function feed(
  est: TrendlineEstimator,
  count: number,
  periodMs: number,
  delayFor: (i: number) => number,
  clockOffsetMs = 0,
): void {
  for (let i = 0; i < count; i++) {
    const sendMs = 1000 + i * periodMs;
    const sample: ArrivalSample = {
      sendMs,
      arrivalMs: sendMs + clockOffsetMs + delayFor(i),
    };
    est.add(sample);
  }
}

test("a link with steady delay reads as normal, however large that delay is", () => {
  const est = new TrendlineEstimator();
  // 250ms of constant one-way delay: a satellite link, not a congested one.
  feed(est, 60, 33, () => 250);
  assert.equal(est.current(), "normal");
});

test("clock offset between the machines does not affect the verdict", () => {
  const synced = new TrendlineEstimator();
  const skewed = new TrendlineEstimator();
  const jitter = (i: number) => (i % 3) - 1;
  feed(synced, 60, 33, jitter, 0);
  // Client clock an hour ahead: only DIFFERENCES are used, so this cancels.
  feed(skewed, 60, 33, jitter, 3_600_000);
  assert.equal(skewed.current(), synced.current());
  assert.equal(
    Math.round(skewed.detail().trend * 1e6),
    Math.round(synced.detail().trend * 1e6),
  );
});

test("a filling queue is detected as overuse", () => {
  const est = new TrendlineEstimator();
  // Each frame waits 6ms longer than the last: a bottleneck backing up.
  feed(est, 60, 33, (i) => i * 6);
  assert.equal(est.current(), "overusing");
  assert.ok(est.detail().trend > 0, `expected a rising trend, got ${est.detail().trend}`);
});

test("a draining queue reads as underusing, not congestion", () => {
  const est = new TrendlineEstimator();
  feed(est, 60, 33, (i) => Math.max(0, 400 - i * 6));
  assert.equal(est.current(), "underusing");
  assert.ok(est.detail().trend < 0, `expected a falling trend, got ${est.detail().trend}`);
});

/**
 * The failure that took down the shipped controller, in the other detector's
 * terms: one big frame is a transient, not congestion. A keyframe delays its
 * own arrival and the next one or two, then the link catches up.
 */
test("a periodic keyframe burst is not congestion", () => {
  const est = new TrendlineEstimator();
  // Every 60th frame (a 2s GOP at 30fps) lands 40ms late and recovers at once.
  feed(est, 300, 33, (i) => (i % 60 === 0 ? 40 : i % 60 === 1 ? 12 : 0));
  assert.equal(est.current(), "normal");
});

test("recovers to normal once the queue stops growing", () => {
  const est = new TrendlineEstimator();
  feed(est, 60, 33, (i) => i * 6);
  assert.equal(est.current(), "overusing", "precondition: congested while filling");

  // Delay now high but FLAT — the queue is full and stable, not still growing.
  const est2 = new TrendlineEstimator();
  feed(est2, 40, 33, (i) => i * 6);
  feed(est2, 120, 33, () => 40 * 6);
  assert.equal(est2.current(), "normal", "a stable standing delay is not a rising gradient");
});

test("says nothing until it has a full window", () => {
  const est = new TrendlineEstimator();
  feed(est, 5, 33, (i) => i * 20);
  assert.equal(est.current(), "normal");
  assert.ok(est.detail().samples < 20);
});

test("reordered frames are ignored rather than inverting the gradient", () => {
  const est = new TrendlineEstimator();
  est.add({ sendMs: 1000, arrivalMs: 1100 });
  est.add({ sendMs: 900, arrivalMs: 1120 }); // arrived out of send order
  est.add({ sendMs: 1033, arrivalMs: 1133 });
  // Nothing blew up and no spurious trend was recorded.
  assert.equal(est.current(), "normal");
});
