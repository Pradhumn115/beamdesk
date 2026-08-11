import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bitrateCeilingForWidth,
  buildQualityLadder,
  decideLadderMove,
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
  assert.equal(full, 20000, "the 1920 baseline must be unchanged");
  assert.ok(small < full, `expected a smaller ceiling at 640px, got ${small}`);
  // Area scaling: (640/1920)^2 = 1/9 of the baseline.
  assert.equal(small, Math.round(20000 / 9));
});

test("a wider-than-1920 display still scales the ceiling up, capped", () => {
  assert.ok(bitrateCeilingForWidth(3456) > 20000);
  assert.ok(bitrateCeilingForWidth(100_000) <= 60000, "cap must hold");
});

test("an engine without encodeWidth falls back to the baseline", () => {
  assert.equal(bitrateCeilingForWidth(undefined), 20000);
});

test("the ceiling never drops below the bitrate floor", () => {
  assert.ok(bitrateCeilingForWidth(320) >= 400);
});

const RUNGS = 6;

test("steps down once congestion at the floor is confirmed", () => {
  const congested = {
    congested: true,
    bitrateKbps: 400,
    ceilingKbps: 20000,
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
    { congested: true, bitrateKbps: 400, ceilingKbps: 20000, rungCount: RUNGS },
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
    ceilingKbps: 2222,
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
    ceilingKbps: 5000,
    rungCount: RUNGS,
  });
  assert.equal(state.healthyChecks, 0);
  assert.equal(state.rung, 2, "no move: congested but not at the floor");
});

test("health below the ceiling banks nothing", () => {
  const state = decideLadderMove(
    { rung: 2, healthyChecks: 3 },
    { congested: false, bitrateKbps: 1000, ceilingKbps: 2222, rungCount: RUNGS },
  );
  assert.equal(state.healthyChecks, 0, "still ramping bitrate, not proof of headroom");
  assert.equal(state.rung, 2);
});

test("never climbs above the top rung", () => {
  const state = decideLadderMove(
    { rung: 0, healthyChecks: 4 },
    { congested: false, bitrateKbps: 20000, ceilingKbps: 20000, rungCount: RUNGS },
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
    { congested: true, bitrateKbps: 400, ceilingKbps: 20000, rungCount: RUNGS },
  );
  assert.equal(next.rung, 0, "must wait for confirmation");
  assert.equal(next.moved, null);
  assert.equal(next.floorChecks, 1);
});

test("descends only after repeated confirmation, then re-arms", () => {
  const congested = {
    congested: true,
    bitrateKbps: 400,
    ceilingKbps: 20000,
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
    ceilingKbps: 20000,
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
      ceilingKbps: 20000,
      rungCount: RUNGS,
    });
  }
  assert.equal(state.rung, 3, `expected 10 ticks / 3 confirmations = 3 rungs, got ${state.rung}`);
});
