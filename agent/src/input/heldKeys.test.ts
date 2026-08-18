import { test } from "node:test";
import assert from "node:assert/strict";
import { InputController, type InputBackend, type ScreenSize } from "./index.js";

/**
 * A backend that models the one property that matters here: a key stays down
 * until something releases it.
 */
function ledgerBackend(size: ScreenSize = { width: 100, height: 100 }) {
  const held: string[] = [];
  const buttons: string[] = [];
  const released: string[][] = [];
  const backend: InputBackend = {
    async screenSize() {
      return size;
    },
    async moveMouse() {},
    async mouseButton(action, button) {
      if (action === "down") buttons.push(button);
      else if (action === "up") {
        const at = buttons.lastIndexOf(button);
        if (at !== -1) buttons.splice(at, 1);
      }
    },
    async scroll() {},
    async keyAction(action, key) {
      if (action === "down") held.push(key);
      else if (action === "up") {
        const at = held.lastIndexOf(key);
        if (at !== -1) held.splice(at, 1);
      }
    },
    hasHeldKeys() {
      return held.length > 0 || buttons.length > 0;
    },
    async releaseAllHeld() {
      const count = held.length + buttons.length;
      released.push([...held, ...buttons]);
      held.length = 0;
      buttons.length = 0;
      return count;
    },
  };
  return { backend, held, buttons, released };
}

/** A controller whose watchdog fires only when the test says so. */
function withManualTimer(backend: InputBackend, onStaleRelease?: (n: number) => void) {
  let pending: (() => void) | null = null;
  const controller = new InputController(backend, {
    onStaleRelease,
    setTimer: (fn) => {
      pending = fn;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      pending = null;
    },
  });
  return { controller, fire: () => pending?.() , isArmed: () => pending !== null };
}

const keyDown = (key: string) =>
  ({ type: "key", action: "down", key, modifiers: [] }) as const;
const keyUp = (key: string) => ({ type: "key", action: "up", key, modifiers: [] }) as const;

test("releaseAllKeys clears everything the backend is holding", async () => {
  const { backend, held } = ledgerBackend();
  const ctrl = new InputController(backend);
  await ctrl.applyKey(keyDown("Meta"));
  await ctrl.applyKey(keyDown("c"));
  assert.deepEqual(held, ["Meta", "c"]);

  const count = await ctrl.releaseAllKeys();
  assert.equal(count, 2);
  assert.deepEqual(held, []);
  ctrl.stop();
});

test("a key-down with no key-up is released once the client goes quiet", async () => {
  // The common shape of the bug: macOS does not deliver keyup for ordinary
  // keys while Command is held, and a tab that loses focus delivers none at
  // all. Without this the modifier stays down for the life of the agent and
  // every later keystroke -- autotyped ones included -- is a shortcut.
  const { backend, held } = ledgerBackend();
  const staleCounts: number[] = [];
  const { controller, fire } = withManualTimer(backend, (n) => staleCounts.push(n));

  await controller.applyKey(keyDown("Meta"));
  assert.deepEqual(held, ["Meta"]);

  fire();
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(held, []);
  assert.deepEqual(staleCounts, [1]);
});

test("the watchdog is not armed when nothing is held", async () => {
  const { backend } = ledgerBackend();
  const { controller, isArmed } = withManualTimer(backend);
  await controller.applyKey(keyDown("a"));
  await controller.applyKey(keyUp("a"));
  assert.equal(isArmed(), false);
});

test("each new keystroke restarts the deadline rather than releasing mid-typing", async () => {
  // Someone holding Shift while typing a sentence must not have it yanked out
  // from under them after five seconds.
  const { backend, held } = ledgerBackend();
  const { controller, isArmed } = withManualTimer(backend);
  await controller.applyKey(keyDown("Shift"));
  await controller.applyKey({ type: "key", action: "press", key: "a", modifiers: ["shift"] });
  assert.equal(isArmed(), true);
  assert.deepEqual(held, ["Shift"]);
});

test("a held mouse button is released too", async () => {
  // A stuck button is a permanent drag: every later move selects or drags
  // something.
  const { backend, buttons } = ledgerBackend();
  const ctrl = new InputController(backend);
  await ctrl.applyMouse({ type: "mouse", action: "down", x: 0.5, y: 0.5, button: "left" });
  assert.deepEqual(buttons, ["left"]);
  await ctrl.releaseAllKeys();
  assert.deepEqual(buttons, []);
  ctrl.stop();
});

test("releasing when nothing is held reports zero rather than inventing a release", async () => {
  // It matters that this is a no-op: libnut clears a modifier by XOR-ing it out
  // of a process-global accumulator, so a release of something not held would
  // set that modifier instead of clearing it.
  const { backend, released } = ledgerBackend();
  const ctrl = new InputController(backend);
  assert.equal(await ctrl.releaseAllKeys(), 0);
  assert.deepEqual(released, [[]]);
  ctrl.stop();
});
