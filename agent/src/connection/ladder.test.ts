import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bitrateCeilingForWidth,
  buildQualityLadder,
  decideLadderMove,
  nextBitrateKbps,
  type LadderState,
} from "./index.js";

/**
 * The ceiling has to follow the rung down. The controller only climbs back up
 * the ladder once bitrate has reached the ceiling, so pinning the ceiling to
 * the 1920 baseline made every step down permanent: a 640px encode was asked
 * to sustain 20 Mbit/s — far more than that many pixels can spend — before it
 * was allowed to return to full resolution.
 */
test("the bitrate ceiling scales down with the encode width", () => {
  const full = bitrateCeilingForWidth(1920);
  const small = bitrateCeilingForWidth(640);
  assert.equal(full, 1_000_000, "the 1920 baseline must be the full budget");
  assert.ok(small < full, `expected a smaller ceiling at 640px, got ${small}`);
  // Area scaling: (640/1920)^2 = 1/9 of the baseline.
  assert.equal(small, Math.round(1_000_000 / 9));
});

test("a wider-than-1920 display still scales the ceiling up, capped", () => {
  assert.ok(bitrateCeilingForWidth(3456) > 20000);
  assert.ok(bitrateCeilingForWidth(100_000) <= 1_000_000, "cap must hold");
});

test("an engine without encodeWidth falls back to the baseline", () => {
  assert.equal(bitrateCeilingForWidth(undefined), 1_000_000);
});

test("the ceiling never drops below the bitrate floor", () => {
  assert.ok(bitrateCeilingForWidth(320) >= 400);
});

const RUNGS = 6;

test("steps down once congestion at the floor is confirmed", () => {
  const congested = {
    congested: true,
    bitrateKbps: 400,
    starved: true,
    rungCount: RUNGS,
  };
  // Confirmation, not immediacy: a lone tick at the floor is often just
  // bitrate still ramping. See LADDER_DOWN_CONFIRM.
  let state: LadderState & { moved?: unknown } = { rung: 0, healthyChecks: 0, floorChecks: 2 };
  state = decideLadderMove(state, congested);
  assert.equal(state.rung, 1);
  assert.equal(state.moved, "down");
});

test("does not descend past the last rung", () => {
  const next = decideLadderMove(
    { rung: RUNGS - 1, healthyChecks: 0, floorChecks: 2 },
    { congested: true, bitrateKbps: 400, starved: true, rungCount: RUNGS },
  );
  assert.equal(next.rung, RUNGS - 1);
  assert.equal(next.moved, null);
});

/** The regression this file exists for: a healthy link must get its pixels back. */
test("climbs back up after sustained health at the ceiling", () => {
  let state: LadderState = { rung: 3, healthyChecks: 0 };
  const healthy = {
    congested: false,
    bitrateKbps: 2222, // at the ceiling for this rung's width, not the 1920 one
    starved: false,
    rungCount: RUNGS,
  };

  // Four quiet ticks bank evidence without moving: stepping up reopens the
  // encoder, so it must not happen on a single good sample.
  for (let i = 0; i < 4; i++) {
    state = decideLadderMove(state, healthy);
    assert.equal(state.rung, 3, `moved too early on tick ${i + 1}`);
  }

  const fifth = decideLadderMove(state, healthy);
  assert.equal(fifth.rung, 2, "expected the 5th healthy check to climb a rung");
  assert.equal(fifth.moved, "up");
  assert.equal(fifth.healthyChecks, 0, "counter resets after a move");
});

test("a single congested tick resets the recovery counter", () => {
  let state: LadderState = { rung: 2, healthyChecks: 4 };
  state = decideLadderMove(state, {
    congested: true,
    bitrateKbps: 5000, // above the floor, so no step down either
    starved: false,
    rungCount: RUNGS,
  });
  assert.equal(state.healthyChecks, 0);
  assert.equal(state.rung, 2, "no move: congested but not at the floor");
});

/**
 * A quiet link is not on its own a reason to grow the picture. If the encoder
 * is spending everything it is allowed, more pixels would spread the same bits
 * thinner; what it needs is more bitrate, which the controller is already
 * pursuing. Only spare budget says the picture can afford to grow.
 */
test("health while the encoder is starved banks nothing", () => {
  const state = decideLadderMove(
    { rung: 2, healthyChecks: 3 },
    { congested: false, bitrateKbps: 1000, starved: true, rungCount: RUNGS },
  );
  assert.equal(state.healthyChecks, 0, "short of bits at this size already");
  assert.equal(state.rung, 2);
});

test("health with bits to spare banks progress toward a climb", () => {
  const state = decideLadderMove(
    { rung: 2, healthyChecks: 3 },
    { congested: false, bitrateKbps: 1000, starved: false, rungCount: RUNGS },
  );
  assert.equal(state.healthyChecks, 4);
});

/**
 * The fault this replaced: recovery used to wait for the TARGET to reach a
 * fixed rate, which a still desktop never justifies -- so a session that had
 * stepped down stayed down until the controller ratcheted its own target up to
 * a number it had invented. Health plus spare budget is now enough.
 */
test("a still screen on a quiet link still climbs back", () => {
  let state: LadderState = { rung: 3, healthyChecks: 0, floorChecks: 0 };
  let climbed = false;
  for (let i = 0; i < 6; i++) {
    const next = decideLadderMove(state, {
      congested: false,
      // A fraction of what a full-size picture would spend, forever.
      bitrateKbps: 900,
      starved: false,
      rungCount: RUNGS,
    });
    state = next;
    if (next.moved === "up") climbed = true;
  }
  assert.ok(climbed, "expected a climb within LADDER_RECOVERY_CHECKS ticks");
  assert.ok(state.rung < 3, `expected to climb, still on rung ${state.rung}`);
});

test("never climbs above the top rung", () => {
  const state = decideLadderMove(
    { rung: 0, healthyChecks: 4 },
    { congested: false, bitrateKbps: 20000, starved: false, rungCount: RUNGS },
  );
  assert.equal(state.rung, 0);
  assert.equal(state.moved, null);
});

/**
 * The observed corruption: diagnostics reporting "320px @ 59fps".
 *
 * A ladder built from a 1280px session drops fps long before its narrowest
 * rung, so 320px can only ever appear at 15fps. Seeing it at the full refresh
 * rate proves the ladder was rebuilt while the encoder was ALREADY scaled down
 * — making 320px rung 0, "best quality", with nothing above it to climb to.
 */
test("a ladder built from the real width never pairs its floor with full fps", () => {
  const ladder = buildQualityLadder(1280, 59);
  const floor = ladder[ladder.length - 1];
  assert.equal(floor.width, 320);
  assert.ok(floor.fps < 59, `the 320px rung must not run at full fps, got ${floor.fps}`);
  assert.equal(ladder[0].width, 1280, "rung 0 must be the session's real starting width");
});

test("a ladder built from an already-degraded width collapses to a single size", () => {
  // This is what must never happen at runtime; asserted so the shape of the
  // failure stays documented if buildQualityLadder is ever changed.
  const corrupted = buildQualityLadder(320, 59);
  assert.deepEqual(
    corrupted.map((r) => r.width),
    [320, 320],
    "every rung is the floor, so there is no way back up",
  );
  assert.equal(corrupted[0].fps, 59, "and rung 0 reports the full refresh rate");
});

/**
 * The descent must not outrun the bitrate controller.
 *
 * Bitrate climbs x1.15 per tick, so ~27 ticks from the floor to a ceiling —
 * while the ladder used to give up a rung on EVERY tick that bitrate sat at
 * the floor. Anything that parked bitrate low (a congestion burst, or
 * un-pinning a resolution after the controller had wound bitrate down) walked
 * the picture to the 320px floor in ~20s, and it then needed five clean checks
 * per rung to climb back.
 */
test("a single congested-at-the-floor tick does not cost a rung", () => {
  const next = decideLadderMove(
    { rung: 0, healthyChecks: 0, floorChecks: 0 },
    { congested: true, bitrateKbps: 400, starved: true, rungCount: RUNGS },
  );
  assert.equal(next.rung, 0, "must wait for confirmation");
  assert.equal(next.moved, null);
  assert.equal(next.floorChecks, 1);
});

test("descends only after repeated confirmation, then re-arms", () => {
  const congested = {
    congested: true,
    bitrateKbps: 400,
    starved: true,
    rungCount: RUNGS,
  };
  let state: LadderState & { moved?: unknown } = { rung: 0, healthyChecks: 0, floorChecks: 0 };
  state = decideLadderMove(state, congested);
  state = decideLadderMove(state, congested);
  assert.equal(state.rung, 0, "still holding after two");
  state = decideLadderMove(state, congested);
  assert.equal(state.rung, 1, "third confirmation spends a rung");
  assert.equal(state.floorChecks, 0, "counter re-arms for the next rung");

  // The next rung must earn its own confirmation rather than falling straight
  // through — this is what turned one bad moment into a full collapse.
  state = decideLadderMove(state, congested);
  assert.equal(state.rung, 1);
});

test("recovering bitrate clears the descent evidence", () => {
  let state: LadderState = { rung: 2, healthyChecks: 0, floorChecks: 2 };
  // One tick where bitrate is off the floor: not proof of health, but proof
  // that the floor evidence is stale.
  state = decideLadderMove(state, {
    congested: true,
    bitrateKbps: 5000,
    starved: false,
    rungCount: RUNGS,
  });
  assert.equal(state.floorChecks, 0);
  assert.equal(state.rung, 2);
});

test("ten congested ticks cost at most three rungs, not ten", () => {
  let state: LadderState = { rung: 0, healthyChecks: 0, floorChecks: 0 };
  for (let i = 0; i < 10; i++) {
    state = decideLadderMove(state, {
      congested: true,
      bitrateKbps: 400,
      starved: true,
      rungCount: RUNGS,
    });
  }
  assert.equal(state.rung, 3, `expected 10 ticks / 3 confirmations = 3 rungs, got ${state.rung}`);
});

/**
 * The target must stay anchored to evidence.
 *
 * With nothing to bound it, the target climbs BITRATE_UP_FACTOR every tick for
 * as long as nothing congests. Measured on an idle loopback link it reached
 * 770Mbit/s while the stream genuinely cost 1.8Mbit/s -- a number the encoder is
 * entitled to spend the instant the content stops being quiet, on a link never
 * tested anywhere near it.
 */
test("a quiet stream does not ratchet the target up to the ceiling", () => {
  let bitrate = 2500;
  // A still desktop: ~1.8Mbit/s actually carried, whatever it is offered.
  for (let i = 0; i < 100; i++) {
    bitrate = nextBitrateKbps({
      previous: bitrate,
      congested: false,
      ceilingKbps: 1_000_000,
      floorKbps: 2500,
      measuredKbps: 1800,
    });
  }
  assert.ok(
    bitrate <= 20000,
    `expected the target to settle near the proven rate, got ${bitrate}kbps`,
  );
});

test("content that really uses its budget can still climb to the ceiling", () => {
  let bitrate = 2500;
  for (let i = 0; i < 200; i++) {
    // A busy screen spends everything it is given.
    bitrate = nextBitrateKbps({
      previous: bitrate,
      congested: false,
      ceilingKbps: 1_000_000,
      floorKbps: 2500,
      measuredKbps: bitrate,
    });
  }
  assert.equal(bitrate, 1_000_000, "the raised budget must remain reachable");
});

test("the measured bound never squeezes below the responsiveness floor", () => {
  // A near-idle screen must keep enough budget to react when it stops being
  // idle, rather than being pinned to 1.5x of almost nothing.
  let bitrate = 400;
  for (let i = 0; i < 100; i++) {
    bitrate = nextBitrateKbps({
      previous: bitrate,
      congested: false,
      ceilingKbps: 1_000_000,
      floorKbps: 2500,
      measuredKbps: 200,
    });
  }
  assert.equal(bitrate, 2500);
});

test("before the first measurement the rule is unchanged", () => {
  assert.equal(
    nextBitrateKbps({
      previous: 2500,
      congested: false,
      ceilingKbps: 1_000_000,
      floorKbps: 2500,
      measuredKbps: null,
    }),
    2875,
  );
});

test("congestion still cuts hard, regardless of what was measured", () => {
  assert.equal(
    nextBitrateKbps({
      previous: 10000,
      congested: true,
      ceilingKbps: 1_000_000,
      floorKbps: 2500,
      measuredKbps: 9000,
    }),
    6000,
  );
  // And never below the floor.
  assert.equal(
    nextBitrateKbps({
      previous: 400,
      congested: true,
      ceilingKbps: 1_000_000,
      floorKbps: 2500,
      measuredKbps: 300,
    }),
    400,
  );
});

/**
 * Congestion should land the target where the link actually is, not step
 * blindly down from wherever the target had drifted to.
 *
 * Against a link collapsing from 10Mbit/s to 800kbit/s the target sat at
 * 20Mbit/s: at BITRATE_DOWN_FACTOR that is nine ticks, eighteen seconds of the
 * encoder being told it may spend twenty times what the link can carry.
 */
test("congestion aims at the carried rate rather than stepping blindly down", () => {
  const next = nextBitrateKbps({
    previous: 20000,
    congested: true,
    ceilingKbps: 1_000_000,
    floorKbps: 2500,
    measuredKbps: 800, // what the link is really managing
  });
  assert.equal(next, 680, "0.85 of the carried rate, in one step");
});

test("an optimistic measurement cannot soften the response", () => {
  // Measurement says the link is fine; congestion says otherwise. The blind
  // step is the ceiling on the outcome, never the floor.
  const next = nextBitrateKbps({
    previous: 10000,
    congested: true,
    ceilingKbps: 1_000_000,
    floorKbps: 2500,
    measuredKbps: 50_000,
  });
  assert.equal(next, 6000, "falls back to the multiplicative step");
});

test("the floor still holds when the link is carrying almost nothing", () => {
  assert.equal(
    nextBitrateKbps({
      previous: 2000,
      congested: true,
      ceilingKbps: 1_000_000,
      floorKbps: 2500,
      measuredKbps: 10,
    }),
    400,
  );
});

test("the target holds while a queue is still draining", () => {
  const next = nextBitrateKbps({
    previous: 5000,
    congested: false,
    ceilingKbps: 1_000_000,
    floorKbps: 2500,
    measuredKbps: 5000,
    draining: true,
  });
  assert.equal(next, 5000, "adding to a draining queue just refills it");
});

/**
 * Congestion alone must not cost resolution.
 *
 * If the encoder still has budget it has not spent, the link congesting says
 * the BITRATE is wrong, not the size -- and the controller has just aimed the
 * target at the carried rate to fix exactly that. Stepping the picture down
 * as well would be paying twice for one problem.
 */
test("congestion with budget to spare does not cost a rung", () => {
  let state: LadderState = { rung: 0, healthyChecks: 0, floorChecks: 0 };
  for (let i = 0; i < 5; i++) {
    state = decideLadderMove(state, {
      congested: true,
      bitrateKbps: 5000,
      starved: false,
      rungCount: RUNGS,
    });
  }
  assert.equal(state.rung, 0, "bitrate is still the lever to pull");
});

test("congestion that survives a starved encoder does cost a rung", () => {
  let state: LadderState = { rung: 0, healthyChecks: 0, floorChecks: 0 };
  let moved: string | null = null;
  // LADDER_DOWN_CONFIRM consecutive congested-and-starved checks.
  for (let i = 0; i < 3; i++) {
    const next = decideLadderMove(state, {
      congested: true,
      bitrateKbps: 900,
      starved: true,
      rungCount: RUNGS,
    });
    state = next;
    moved = next.moved;
  }
  assert.equal(moved, "down", "no bits left to find; the picture must shrink");
  assert.equal(state.rung, 1);
});
