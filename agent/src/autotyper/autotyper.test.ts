import { test } from "node:test";
import assert from "node:assert/strict";
import { looksIndented, runAutotype, type TypingBackend } from "./index.js";

function recorder() {
  const events: string[] = [];
  const backend: TypingBackend = {
    async typeChar(ch) {
      events.push(ch);
    },
    async backspace() {
      events.push("<BS>");
    },
    async pressEnter() {
      events.push("<CR>");
    },
    async selectToLineStart() {
      events.push("<SEL>");
    },
  };
  return { events, backend };
}

const noSleep = async (): Promise<void> => {};

test("types the exact text when typoRate is 0", async () => {
  const { events, backend } = recorder();
  await runAutotype(
    "hello",
    { baseDelayMs: 10, jitterMs: 5, typoRate: 0 },
    { backend, sleep: noSleep, rng: () => 0.5 },
  );
  assert.equal(events.join(""), "hello");
});

test("reports progress for every character", async () => {
  const { backend } = recorder();
  const progress: Array<[number, number]> = [];
  await runAutotype(
    "abc",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 0 },
    { backend, sleep: noSleep, rng: () => 0.9 },
    { onProgress: (done, total) => progress.push([done, total]) },
  );
  assert.deepEqual(progress, [
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
});

test("injects a typo + backspace + correction when rng forces it", async () => {
  const { events, backend } = recorder();
  // rng always returns 0 -> typoRate check (0 < rate) triggers, and adjacent
  // index 0 is chosen. Final text must still be correct.
  await runAutotype(
    "a",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 1 },
    { backend, sleep: noSleep, rng: () => 0 },
  );
  // For 'a', neighbors = "sqwz", index 0 -> 's'. So: s, <BS>, a
  assert.deepEqual(events, ["s", "<BS>", "a"]);
});

test("delay stays non-negative even with large jitter", async () => {
  const { backend } = recorder();
  const waited: number[] = [];
  await runAutotype(
    "xy",
    { baseDelayMs: 5, jitterMs: 1000, typoRate: 0 },
    {
      backend,
      sleep: async (ms) => {
        waited.push(ms);
      },
      rng: () => 0, // jitter = (0*2-1)*1000 = -1000 -> clamps to 0
    },
  );
  assert.ok(waited.every((w) => w >= 0));
});

test("stops typing when the signal is aborted mid-run", async () => {
  const { events, backend } = recorder();
  const controller = new AbortController();
  // Abort after the 3rd character is typed.
  const hooks = {
    onProgress: (done: number) => {
      if (done === 3) controller.abort();
    },
  };
  const completed = await runAutotype(
    "abcdefghij",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 0 },
    { backend, sleep: noSleep, rng: () => 0.9, signal: controller.signal },
    hooks,
  );
  assert.equal(completed, false); // reported as cancelled
  assert.equal(events.join(""), "abc"); // stopped after the 3rd char
});

test("presses Enter for a newline instead of typing it as a character", async () => {
  const { events, backend } = recorder();
  await runAutotype(
    "one.\ntwo",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 0 },
    { backend, sleep: noSleep, rng: () => 0.9 },
  );
  // The line break must be a real Return press, otherwise "two" continues on
  // the same line right after the period: "one.two".
  assert.deepEqual(events, ["o", "n", "e", ".", "<CR>", "t", "w", "o"]);
});

test("treats CRLF as a single Enter press", async () => {
  const { events, backend } = recorder();
  await runAutotype(
    "a\r\nb",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 0 },
    { backend, sleep: noSleep, rng: () => 0.9 },
  );
  assert.deepEqual(events, ["a", "<CR>", "b"]);
});

test("never injects a typo in place of a line break", async () => {
  const { events, backend } = recorder();
  await runAutotype(
    "\n",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 1 },
    { backend, sleep: noSleep, rng: () => 0 },
  );
  assert.deepEqual(events, ["<CR>"]);
});

test("returns true when it finishes without abort", async () => {
  const { backend } = recorder();
  const completed = await runAutotype(
    "hi",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 0 },
    { backend, sleep: noSleep, rng: () => 0.9 },
  );
  assert.equal(completed, true);
});

test("preserves case when correcting an uppercase typo", async () => {
  const { events, backend } = recorder();
  await runAutotype(
    "A",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 1 },
    { backend, sleep: noSleep, rng: () => 0 },
  );
  // 'A' neighbors from 'a' = "sqwz"[0] = 's' -> uppercased 'S'
  assert.deepEqual(events, ["S", "<BS>", "A"]);
});

/**
 * Editors auto-indent after Return, and the source text then types its own
 * leading whitespace on top. Because each guess is based on the previous
 * (already doubled) line, the error compounds into a pyramid. Selecting back
 * to the line start makes the typed indentation REPLACE the editor's guess.
 */
test("clears the editor's auto-indent before typing an indented line", async () => {
  const { events, backend } = recorder();
  await runAutotype(
    "if x:\n    pass",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 0 },
    { backend, sleep: noSleep, rng: () => 0.9 },
  );
  assert.deepEqual(events, [
    "i", "f", " ", "x", ":",
    "<CR>", "<SEL>",
    " ", " ", " ", " ", "p", "a", "s", "s",
  ]);
});

test("plain prose is typed without the guard", async () => {
  const { events, backend } = recorder();
  await runAutotype(
    "hello\nworld",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 0 },
    { backend, sleep: noSleep, rng: () => 0.9 },
  );
  assert.ok(!events.includes("<SEL>"), "no editor fights indentation in prose");
});

test("the guard can be forced on or off explicitly", async () => {
  const forcedOn = recorder();
  await runAutotype(
    "a\nb",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 0 },
    { backend: forcedOn.backend, sleep: noSleep, rng: () => 0.9, guardIndent: true },
  );
  assert.ok(forcedOn.events.includes("<SEL>"));

  const forcedOff = recorder();
  await runAutotype(
    "if x:\n    pass",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 0 },
    { backend: forcedOff.backend, sleep: noSleep, rng: () => 0.9, guardIndent: false },
  );
  assert.ok(!forcedOff.events.includes("<SEL>"));
});

test("a backend without selectToLineStart still types", async () => {
  const events: string[] = [];
  const bare: TypingBackend = {
    async typeChar(ch) {
      events.push(ch);
    },
    async backspace() {},
    async pressEnter() {
      events.push("<CR>");
    },
  };
  await runAutotype(
    "if x:\n    pass",
    { baseDelayMs: 0, jitterMs: 0, typoRate: 0 },
    { backend: bare, sleep: noSleep, rng: () => 0.9 },
  );
  assert.equal(events.join(""), "if x:<CR>    pass");
});

test("looksIndented recognises code and ignores prose", () => {
  assert.equal(looksIndented("def f():\n    return 1"), true);
  assert.equal(looksIndented("\tindented with a tab"), false, "no preceding newline");
  assert.equal(looksIndented("one\ntwo\nthree"), false);
  assert.equal(looksIndented("a\n\nb"), false, "blank lines are not indentation");
  assert.equal(looksIndented("single line"), false);
});
