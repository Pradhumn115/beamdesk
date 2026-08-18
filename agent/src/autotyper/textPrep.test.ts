import { test } from "node:test";
import assert from "node:assert/strict";
import { expandTabs, foldTypographic, prepareText, stripControls } from "./textPrep.js";

test("a tab advances to the next tab stop, not a fixed number of spaces", () => {
  assert.equal(expandTabs("ab\tc", 4).text, "ab  c");
  assert.equal(expandTabs("a\tb", 4).text, "a   b");
  assert.equal(expandTabs("\tx", 4).text, "    x");
});

test("tab stops are measured from the start of each line", () => {
  // Without the per-line reset the second line would be indented by the
  // characters on the first, and pasted code would drift out of shape.
  assert.equal(expandTabs("abc\n\tx", 4).text, "abc\n    x");
});

test("expandTabs counts what it replaced", () => {
  assert.equal(expandTabs("\t\ta", 4).count, 2);
  assert.equal(expandTabs("no tabs", 4).count, 0);
});

test("control characters are stripped but line breaks and tabs survive", () => {
  const { text, count } = stripControls("abc\n\td");
  assert.equal(text, "abc\n\td");
  assert.equal(count, 3);
});

test("typographic lookalikes fold to the ASCII they stand in for", () => {
  const { text } = foldTypographic("“it’s” — a test…");
  assert.equal(text, '"it\'s" - a test...');
});

test("zero-width characters fold away entirely", () => {
  // They cost a keystroke and produce nothing, and in code they are invisible
  // syntax errors.
  const { text, count } = foldTypographic("a​b﻿c");
  assert.equal(text, "abc");
  assert.equal(count, 2);
});

test("prepareText expands tabs by default", () => {
  const { text, report } = prepareText("a\tb");
  assert.equal(text, "a   b");
  assert.equal(report.tabsExpanded, 1);
});

test("prepareText leaves tabs alone when asked to", () => {
  const { text } = prepareText("a\tb", { expandTabs: false });
  assert.equal(text, "a\tb");
});

test("prepareText only folds typographic characters on request", () => {
  assert.equal(prepareText("—").text, "—");
  assert.equal(prepareText("—", { foldTypographic: true }).text, "-");
});

test("folding happens before tab expansion so columns stay right", () => {
  // An ellipsis folds to three characters; the tab after it must advance from
  // the post-fold column, or the indentation lands one stop off.
  const { text } = prepareText("…\tx", { foldTypographic: true, tabWidth: 4 });
  // "…" folds to three characters, so the tab at column 3 pads by one.
  assert.equal(text, "... x");
});
