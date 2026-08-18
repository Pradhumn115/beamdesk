/**
 * Text sanitisation applied before a single keystroke is emitted.
 *
 * Autotyped text is not just data -- every character becomes a real key event
 * on someone's machine, and a handful of characters turn into commands rather
 * than text. This module removes those characters before they can.
 */

/** Report of what sanitisation changed, so a run can be logged honestly. */
export interface PrepReport {
  tabsExpanded: number;
  controlsStripped: number;
  typographicFolded: number;
}

export interface PrepOptions {
  /**
   * Replace tab characters with spaces (default true).
   *
   * A tab is not text in most targets: in a browser it moves focus to the next
   * control, and everything typed after it lands on whatever now has focus --
   * where bare letters are application shortcuts. One tab in a pasted snippet
   * is enough to turn the rest of a run into a stream of stray commands.
   */
  expandTabs?: boolean;
  /** Column width a tab advances to. Default 4. */
  tabWidth?: number;
  /**
   * Fold typographic characters to their ASCII equivalents (default false).
   *
   * Only needed for backends that resolve characters through the OS keyboard
   * layout -- see TypingBackend.layoutSafe. Such a backend cannot type a
   * character the layout lacks, and libnut in particular turns those into
   * Shift+Ctrl+Alt plus an arbitrary virtual key.
   */
  foldTypographic?: boolean;
}

/**
 * Characters that look like ASCII punctuation but are not, mapped to what they
 * stand in for. Word processors and chat apps substitute these silently, so
 * they arrive in pasted text constantly.
 */
const TYPOGRAPHIC: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-",
  "—": "-", "―": "-", "−": "-",
  "…": "...",
  // Spaces that are not U+0020.
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
  "　": " ",
  "«": '"', "»": '"', "‹": "'", "›": "'",
  "⁄": "/", "∕": "/",
  // Zero-width characters type as nothing but still cost a keystroke, and in
  // code they are invisible syntax errors.
  "​": "", "‌": "", "‍": "", "﻿": "",
};

/**
 * Expand tabs to spaces, advancing to the next multiple of `width` measured
 * from the start of the current line -- the same rule an editor uses, so
 * tab-indented code keeps its shape.
 */
export function expandTabs(text: string, width: number): { text: string; count: number } {
  let out = "";
  let column = 0;
  let count = 0;
  for (const ch of text) {
    if (ch === "\n" || ch === "\r") {
      out += ch;
      column = 0;
    } else if (ch === "\t") {
      const pad = width - (column % width);
      out += " ".repeat(pad);
      column += pad;
      count++;
    } else {
      out += ch;
      column++;
    }
  }
  return { text: out, count };
}

/**
 * Strip C0/C1 control characters, keeping only the line breaks the autotyper
 * knows how to press and the tabs that expandTabs will deal with.
 *
 * A stray control character is never what the sender meant, and it is not
 * harmless: typed literally it can ring a bell, clear a terminal, send EOF, or
 * -- through a layout-resolving backend -- resolve to a virtual key that has
 * nothing to do with the character.
 */
export function stripControls(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, () => {
    count++;
    return "";
  });
  return { text: out, count };
}

export function foldTypographic(text: string): { text: string; count: number } {
  let count = 0;
  let out = "";
  for (const ch of text) {
    const replacement = TYPOGRAPHIC[ch];
    if (replacement === undefined) {
      out += ch;
    } else {
      out += replacement;
      count++;
    }
  }
  return { text: out, count };
}

/** Run every applicable pass, in the order that keeps their effects independent. */
export function prepareText(
  text: string,
  options: PrepOptions = {},
): { text: string; report: PrepReport } {
  const { expandTabs: doTabs = true, tabWidth = 4, foldTypographic: doFold = false } = options;

  // Controls first: a stripped control character must not shift the column
  // count that tab expansion is about to measure.
  const controls = stripControls(text);
  let current = controls.text;

  let folded = 0;
  if (doFold) {
    const result = foldTypographic(current);
    current = result.text;
    folded = result.count;
  }

  let tabs = 0;
  if (doTabs) {
    const result = expandTabs(current, tabWidth);
    current = result.text;
    tabs = result.count;
  }

  return {
    text: current,
    report: {
      tabsExpanded: tabs,
      controlsStripped: controls.count,
      typographicFolded: folded,
    },
  };
}
