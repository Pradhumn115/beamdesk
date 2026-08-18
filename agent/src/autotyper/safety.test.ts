import { test } from "node:test";
import assert from "node:assert/strict";
import { runAutotype, type TypingBackend } from "./index.js";

/** A recorder that also tracks release calls and can be told to fail. */
function guardedRecorder(options: { layoutSafe?: boolean; failOn?: string } = {}) {
  const events: string[] = [];
  const backend: TypingBackend = {
    layoutSafe: options.layoutSafe,
    async typeChar(ch) {
      if (ch === options.failOn) throw new Error("backend failed");
      events.push(ch);
    },
    async backspace() {
      events.push("<BS>");
    },
    async pressEnter() {
      events.push("<CR>");
    },
    async pressTab() {
      events.push("<TAB>");
    },
    async selectToLineStart() {
      events.push("<SEL>");
    },
    async releaseAll() {
      events.push("<REL>");
    },
  };
  return { events, backend };
}

const noSleep = async (): Promise<void> => {};
const plain = { baseDelayMs: 0, jitterMs: 0, typoRate: 0 };
const typed = (events: string[]): string => events.join("").replace(/<REL>/g, "");

test("the modifier state is cleared before the first keystroke and after the last", async () => {
  // A modifier left down by anything else turns every character below into a
  // shortcut, so a run must not assume it starts clean.
  const { events, backend } = guardedRecorder({ layoutSafe: true });
  await runAutotype("hi", plain, { backend, sleep: noSleep, rng: () => 0.5 });
  assert.equal(events[0], "<REL>");
  assert.equal(events[events.length - 1], "<REL>");
});

test("modifiers are released even when the backend throws mid-run", async () => {
  const { events, backend } = guardedRecorder({ layoutSafe: true, failOn: "b" });
  await assert.rejects(
    runAutotype("ab", plain, { backend, sleep: noSleep, rng: () => 0.5 }),
    /backend failed/,
  );
  assert.equal(events[events.length - 1], "<REL>");
});

test("modifiers are released after a cancelled run", async () => {
  const abort = new AbortController();
  abort.abort();
  const { events, backend } = guardedRecorder({ layoutSafe: true });
  const completed = await runAutotype("hi", plain, {
    backend,
    sleep: noSleep,
    rng: () => 0.5,
    signal: abort.signal,
  });
  assert.equal(completed, false);
  assert.equal(events[events.length - 1], "<REL>");
});

test("a tab is typed as spaces, never as a Tab key press", async () => {
  // A Tab keystroke moves focus in a browser, and every character after it
  // lands wherever focus went -- where bare letters are application shortcuts.
  const { events, backend } = guardedRecorder({ layoutSafe: true });
  await runAutotype("a\tb", plain, { backend, sleep: noSleep, rng: () => 0.5 });
  assert.equal(events.includes("<TAB>"), false);
  assert.equal(typed(events), "a   b");
});

test("literalTabs opts back in to a real Tab key press", async () => {
  const { events, backend } = guardedRecorder({ layoutSafe: true });
  await runAutotype("a\tb", plain, {
    backend,
    sleep: noSleep,
    rng: () => 0.5,
    literalTabs: true,
  });
  assert.equal(events.includes("<TAB>"), true);
});

test("a layout-resolving backend never sees a character the layout may lack", async () => {
  // libnut asks VkKeyScan for a keycode and presses whatever modifiers it
  // reports; a character absent from the layout comes back as -1, which it
  // reads as Shift+Ctrl+Alt plus an arbitrary virtual key. In a browser that
  // is Ctrl+T.
  const { events, backend } = guardedRecorder({ layoutSafe: false });
  await runAutotype("“x”", plain, { backend, sleep: noSleep, rng: () => 0.5 });
  assert.equal(typed(events), '"x"');
});

test("a layout-safe backend receives the text unfolded", async () => {
  const { events, backend } = guardedRecorder({ layoutSafe: true });
  await runAutotype("“x”", plain, { backend, sleep: noSleep, rng: () => 0.5 });
  assert.equal(typed(events), "“x”");
});

test("control characters never reach the backend", async () => {
  // A stray control code can ring a bell, clear a terminal, or send EOF.
  const { events, backend } = guardedRecorder({ layoutSafe: true });
  await runAutotype("a\u0007b\u001Bc", plain, { backend, sleep: noSleep, rng: () => 0.5 });
  assert.equal(typed(events), "abc");
});
