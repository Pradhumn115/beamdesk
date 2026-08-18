import { test } from "node:test";
import assert from "node:assert/strict";
import { FramePacer } from "./pacer.js";

/** A pacer on a controllable clock, with a queue of pending timers. */
function harness(targetKbps: number) {
  let now = 0;
  const sent: number[] = [];
  const timers: Array<{ at: number; fn: () => void }> = [];
  const pacer = new FramePacer({
    send: (f) => sent.push(f.byteLength),
    now: () => now,
    schedule: (fn, ms) => timers.push({ at: now + ms, fn }),
  });
  pacer.setTargetKbps(targetKbps);
  /** Advances the clock, firing timers as they come due. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      now = Math.max(now, next.at);
      next.fn();
    }
    now = end;
  };
  return { pacer, sent, advance, at: () => now };
}

test("ordinary frames are never delayed", () => {
  // 2000kbps at 30fps is ~8300 bytes a frame; the bucket refills 2.5x faster.
  const { pacer, sent, advance } = harness(2000);
  for (let i = 0; i < 30; i++) {
    advance(33);
    pacer.enqueue(new Uint8Array(8300));
  }
  assert.equal(sent.length, 30, "every frame went out on arrival");
  assert.equal(pacer.queuedBytes, 0);
});

/**
 * The burst this class exists to remove: an IDR is tens of times its
 * neighbours, and handing it over whole is what a receiver cannot tell apart
 * from the link stalling.
 */
test("a keyframe burst is spread over the frames that follow it", () => {
  const { pacer, sent, advance } = harness(2000);
  advance(1000); // start with a full bucket, as an idle link would
  pacer.enqueue(new Uint8Array(250_000)); // the IDR
  const afterIdr = sent.length;
  for (let i = 0; i < 5; i++) {
    advance(33);
    pacer.enqueue(new Uint8Array(8300));
  }
  assert.equal(afterIdr, 1, "the keyframe itself must not wait");
  assert.ok(
    pacer.queuedBytes > 0,
    "the frames behind it should still be paying off its debt",
  );
  assert.ok(sent.length < 6, `expected the following frames to be held, sent ${sent.length}`);
});

test("the debt is paid off and the queue drains", () => {
  const { pacer, sent, advance } = harness(2000);
  advance(1000);
  pacer.enqueue(new Uint8Array(250_000));
  for (let i = 0; i < 5; i++) {
    advance(33);
    pacer.enqueue(new Uint8Array(8300));
  }
  advance(2000); // give the bucket time to catch up
  assert.equal(pacer.queuedBytes, 0, "everything eventually goes out");
  assert.equal(sent.length, 6);
});

test("nothing is ever discarded", () => {
  const { pacer, sent, advance } = harness(400); // a floor-rate link
  let total = 0;
  for (let i = 0; i < 40; i++) {
    advance(33);
    const size = i % 10 === 0 ? 60_000 : 1600;
    total += size;
    pacer.enqueue(new Uint8Array(size));
  }
  advance(60_000);
  assert.equal(sent.length, 40, "a paced frame is delayed, never dropped");
  assert.equal(
    sent.reduce((a, b) => a + b, 0),
    total,
  );
});

test("an idle link cannot bank an unlimited burst", () => {
  const { pacer, sent, advance } = harness(2000);
  advance(60_000); // a minute of stillness
  // Four frames at once: with unbounded credit all four would leave together.
  for (let i = 0; i < 4; i++) pacer.enqueue(new Uint8Array(20_000));
  assert.ok(sent.length < 4, `banked credit released ${sent.length} frames at once`);
});

/**
 * The release rate follows the controller's target, so a link that has earned
 * more bandwidth smooths the same burst over less time.
 *
 * Sized to stay inside MAX_QUEUE_MS at both rates: past that bound the pacer
 * releases everything regardless, which is a different behaviour with its own
 * test above.
 */
test("a higher target drains a burst faster", () => {
  const drainedIn = (kbps: number) => {
    const h = harness(kbps);
    for (let i = 0; i < 3; i++) h.pacer.enqueue(new Uint8Array(20_000));
    h.advance(20);
    return h.sent.length;
  };
  const fast = drainedIn(8000);
  const slow = drainedIn(2000);
  assert.ok(fast > slow, `expected the faster target to release more: fast=${fast} slow=${slow}`);
});

/**
 * Smoothing is worth tens of milliseconds, not hundreds. A queue of video in a
 * remote-control session is a queue of stale pictures.
 */
test("never holds more than a bounded amount of video", () => {
  const { pacer, advance } = harness(2000); // ~625 bytes/ms of release
  // Far more than the link can smooth: 20 frames of 50KB in one frame interval.
  for (let i = 0; i < 20; i++) pacer.enqueue(new Uint8Array(50_000));
  advance(1);
  // 120ms of release at this rate is ~75KB; allow generous slack for the frame
  // that is mid-flight, but nothing like the 470KB measured without the bound.
  assert.ok(
    pacer.queuedBytes < 150_000,
    `pacer held ${pacer.queuedBytes} bytes, which is seconds of staleness`,
  );
});
