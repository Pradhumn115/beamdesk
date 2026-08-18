import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBacklog } from "./backlog.js";

test("counts what is outstanding and clears it when settled", () => {
  const b = new SessionBacklog();
  const s = {};
  b.open(s);
  const settle = b.begin(s, 50_000);
  assert.equal(b.bytes, 50_000);
  settle();
  assert.equal(b.bytes, 0);
});

/**
 * The leak this class exists to prevent. A write to a session whose client has
 * gone away may never settle, so the bytes must leave with the session -- not
 * wait for a `finally` that will never run.
 *
 * Observed as a backlog frozen at exactly 633KB across reconnects, which the
 * controller read as a permanently congested link and answered by walking the
 * quality ladder from 1920p to 320p.
 */
test("a dead session takes its unsettled bytes with it", () => {
  const b = new SessionBacklog();
  const s = {};
  b.open(s);
  b.begin(s, 633 * 1024); // never settled: the client vanished mid-write
  assert.equal(b.bytes, 633 * 1024);
  b.close(s);
  assert.equal(b.bytes, 0, "a closed session must not be read as a live queue");
});

test("reconnecting does not accumulate the ghosts of old sessions", () => {
  const b = new SessionBacklog();
  for (let i = 0; i < 5; i++) {
    const s = {};
    b.open(s);
    b.begin(s, 150_000); // stranded, as every reconnect stranded its writes
    b.close(s);
  }
  assert.equal(b.bytes, 0, "five reconnects previously left five sessions' worth behind");
});

test("a write settling after its session closed is harmless", () => {
  const b = new SessionBacklog();
  const s = {};
  b.open(s);
  const settle = b.begin(s, 10_000);
  b.close(s);
  settle(); // the promise finally resolved, long after nobody cared
  assert.equal(b.bytes, 0, "must not go negative or resurrect the account");
});

test("settling twice counts once", () => {
  const b = new SessionBacklog();
  const s = {};
  b.open(s);
  const settle = b.begin(s, 8000);
  const other = b.begin(s, 2000);
  settle();
  settle();
  assert.equal(b.bytes, 2000);
  other();
  assert.equal(b.bytes, 0);
});

test("sessions are counted independently", () => {
  const b = new SessionBacklog();
  const a = {};
  const c = {};
  b.open(a);
  b.open(c);
  b.begin(a, 30_000);
  const settleC = b.begin(c, 70_000);
  assert.equal(b.bytes, 100_000);
  assert.equal(b.sessionCount, 2);
  b.close(a);
  assert.equal(b.bytes, 70_000, "closing one must not disturb the other");
  settleC();
  assert.equal(b.bytes, 0);
});

test("writing to a session that was never opened is ignored", () => {
  const b = new SessionBacklog();
  const settle = b.begin({}, 5000);
  assert.equal(b.bytes, 0);
  settle();
  assert.equal(b.bytes, 0);
});
