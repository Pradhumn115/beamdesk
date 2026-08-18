import { test } from "node:test";
import assert from "node:assert/strict";
import { AckedRateTracker } from "./ackedrate.js";

/** `count` frames of `bytes` each, arriving every `periodMs`. */
function stream(t: AckedRateTracker, count: number, periodMs: number, bytes: number, from = 0) {
  for (let i = 0; i < count; i++) t.add({ seq: from + i, arrivalMs: from + i * periodMs, bytes });
}

test("reports the rate the receiver actually got", () => {
  const t = new AckedRateTracker();
  // 4166 bytes every 33ms ~= 1010 kbit/s.
  stream(t, 60, 33, 4166);
  const rate = t.rateKbps();
  assert.ok(rate !== null && rate > 900 && rate < 1100, `expected ~1010kbps, got ${rate}`);
});

test("says nothing until there is enough to say it with", () => {
  const t = new AckedRateTracker();
  assert.equal(t.rateKbps(), null, "no samples");
  t.add({ seq: 1, arrivalMs: 1000, bytes: 5000 });
  assert.equal(t.rateKbps(), null, "one sample is not a rate");
  t.add({ seq: 2, arrivalMs: 1010, bytes: 5000 });
  assert.equal(t.rateKbps(), null, "10ms is too short a span to extrapolate from");
});

test("a burst does not read as sustained capacity", () => {
  const t = new AckedRateTracker();
  // Twenty frames delivered back to back in 20ms: a flush, not a fast link.
  stream(t, 20, 1, 60_000);
  assert.equal(t.rateKbps(), null, "a sub-window burst must not produce a rate");
});

test("follows the link down when delivery collapses", () => {
  const t = new AckedRateTracker();
  stream(t, 60, 33, 4166, 0); // ~1Mbit/s
  const before = t.rateKbps()!;
  // Delivery drops to a trickle; window slides past the healthy samples.
  stream(t, 30, 66, 400, 2000);
  const after = t.rateKbps()!;
  assert.ok(after < before / 3, `expected the rate to collapse, ${before} -> ${after}`);
});

test("old samples fall out of the window", () => {
  const t = new AckedRateTracker();
  stream(t, 60, 33, 50_000, 0); // a fast burst long ago
  stream(t, 40, 50, 1000, 10_000); // the recent, slow truth
  const rate = t.rateKbps()!;
  // 1000 bytes per 50ms = 160kbps; the ancient fast samples must not inflate it.
  assert.ok(rate < 400, `stale samples leaked into the rate: ${rate}kbps`);
});

test("out-of-order reports do not corrupt the rate", () => {
  const ordered = new AckedRateTracker();
  const shuffled = new AckedRateTracker();
  const samples = Array.from({ length: 60 }, (_, i) => ({ seq: i, arrivalMs: i * 33, bytes: 4166 }));
  for (const s of samples) ordered.add(s);
  for (const s of [...samples].reverse()) shuffled.add(s);
  assert.equal(shuffled.rateKbps(), ordered.rateKbps());
});

/**
 * A probe is far shorter than the trailing window, so it has to be asked about
 * on its own terms or the quiet traffic around it buries the answer.
 */
test("a run of frames can be measured apart from the traffic around it", () => {
  const t = new AckedRateTracker();
  // Ordinary traffic: ~250kbps.
  for (let i = 0; i < 20; i++) t.add({ seq: i, arrivalMs: i * 33, bytes: 1000 });
  // A probe burst in the middle of it: ~2400kbps over its own frames.
  for (let i = 100; i < 120; i++) t.add({ seq: i, arrivalMs: 660 + (i - 100) * 33, bytes: 10_000 });
  const probe = t.rateForSeqRange(100, 119)!;
  assert.ok(probe > 2000 && probe < 3000, `expected ~2400kbps for the probe, got ${probe}`);
});

test("an unanswered range reports nothing rather than guessing", () => {
  const t = new AckedRateTracker();
  for (let i = 0; i < 20; i++) t.add({ seq: i, arrivalMs: i * 33, bytes: 1000 });
  assert.equal(t.rateForSeqRange(500, 600), null);
});
