import type { AutotypeProfile } from "@bcsa/shared";
import { prepareText, type PrepReport } from "./textPrep.js";

/** Backend that actually emits keystrokes. Kept minimal for testability. */
export interface TypingBackend {
  typeChar(ch: string): Promise<void>;
  backspace(): Promise<void>;
  /**
   * Press Return. Line breaks need a real key press: typing "\n" as a
   * character emits a control code most apps ignore, which silently joins the
   * next line onto the current one.
   */
  pressEnter(): Promise<void>;
  /**
   * Select from the caret back to the start of the line.
   *
   * Used to neutralise an editor's auto-indent: whatever it inserted after
   * Return ends up selected, so the first character typed replaces it and the
   * line lands at exactly the indentation the source text specifies.
   *
   * Optional because not every target can do it — a terminal may echo the key
   * as an escape sequence rather than selecting — and a backend that omits it
   * simply types without the guard.
   */
  selectToLineStart?(): Promise<void>;
  /**
   * Press a real Tab key. Optional, and deliberately unused by default -- see
   * PrepOptions.expandTabs for why a tab is usually the wrong thing to send.
   */
  pressTab?(): Promise<void>;
  /**
   * Release anything this backend might still be holding.
   *
   * Called before a run starts and after it ends. A modifier left down turns
   * every following keystroke into a shortcut, and the cost of asking is one
   * key event against the cost of an unbounded stream of stray commands.
   */
  releaseAll?(): Promise<void>;
  /** Free any helper process. Called on agent shutdown. */
  dispose?(): void;
  /**
   * True when characters are delivered without consulting the OS keyboard
   * layout -- macOS CGEventKeyboardSetUnicodeString, Windows KEYEVENTF_UNICODE.
   *
   * A layout-resolving backend cannot type a character the active layout
   * lacks, and libnut's Windows path answers that case by pressing
   * Shift+Ctrl+Alt with an arbitrary virtual key. Callers fold text to ASCII
   * before handing it to a backend that reports false.
   */
  readonly layoutSafe?: boolean;
}

export interface AutotypeHooks {
  onProgress?(done: number, total: number): void;
}

export interface AutotypeDeps {
  backend: TypingBackend;
  /** Resolve after `ms` milliseconds. Injectable so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  /** Returns a float in [0, 1). Injectable for deterministic tests. */
  rng?: () => number;
  /** Abort to stop typing mid-run (checked between keystrokes). */
  signal?: AbortSignal;
  /**
   * Overrides the automatic decision described in looksIndented().
   *
   * Left undefined the guard turns itself on for text that carries its own
   * indentation, which is the common case for pasted code and never applies to
   * ordinary prose.
   */
  guardIndent?: boolean;
  /**
   * Send tabs as a real Tab key press instead of expanding them to spaces.
   *
   * Off by default. A Tab keystroke moves focus in a browser, and every
   * character after that lands wherever focus went -- on a page body, where
   * bare letters are application shortcuts. Only enable it for a target known
   * to treat Tab as indentation.
   */
  literalTabs?: boolean;
  /** Columns a tab expands to when literalTabs is off. Default 4. */
  tabWidth?: number;
  /** Called once with what sanitisation changed, for logging. */
  onPrepared?: (report: PrepReport) => void;
}

/**
 * Whether `text` carries indentation the editor will fight over.
 *
 * An editor auto-indents each new line, and the source text then types its own
 * leading whitespace on top, so the two add up. Worse, the editor bases its
 * guess on the previous line — which is already doubled — so the error
 * compounds and the block fans out into a pyramid:
 *
 *   def f():          <- correct
 *       if x:         <- editor 4 + source 4  = 8
 *               pass  <- editor 8 + source 8  = 16
 *
 * Detecting it is enough to decide: only text with an indented continuation
 * line can be mangled this way, and for anything else the guard is a wasted
 * keypress per line.
 */
export function looksIndented(text: string): boolean {
  return /\n[ \t]+\S/.test(text);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Rough QWERTY adjacency for realistic typos.
const ADJACENT: Record<string, string> = {
  a: "sqwz", b: "vghn", c: "xdfv", d: "serfcx", e: "wsdr", f: "drtgvc",
  g: "ftyhbv", h: "gyujnb", i: "ujko", j: "huikmn", k: "jiolm", l: "kop",
  m: "njk", n: "bhjm", o: "iklp", p: "ol", q: "wa", r: "edft", s: "awedxz",
  t: "rfgy", u: "yhji", v: "cfgb", w: "qase", x: "zsdc", y: "tghu", z: "asx",
};

function pickTypo(ch: string, rng: () => number): string | null {
  const neighbors = ADJACENT[ch.toLowerCase()];
  if (!neighbors) return null;
  const pick = neighbors[Math.floor(rng() * neighbors.length)];
  // Preserve case of the intended character.
  return ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? pick.toUpperCase() : pick;
}

/**
 * Type `text` on the backend with human-like cadence: each keystroke is delayed
 * by `baseDelayMs` +/- a random amount up to `jitterMs`, and with probability
 * `typoRate` a wrong adjacent key is pressed first, then backspaced and
 * corrected. Progress is reported per character.
 *
 * Passing `deps.signal` allows cancelling mid-run: the loop stops before the
 * next keystroke once the signal is aborted. Returns true if it completed the
 * whole text, false if it was cancelled.
 */
export async function runAutotype(
  rawText: string,
  profile: AutotypeProfile,
  deps: AutotypeDeps,
  hooks: AutotypeHooks = {},
): Promise<boolean> {
  const sleep = deps.sleep ?? defaultSleep;
  const rng = deps.rng ?? Math.random;

  // Sanitise before a single key event goes out. Characters that resolve to
  // commands rather than text -- tabs that move focus, control codes, and (for
  // a layout-resolving backend) anything absent from the active layout -- are
  // removed here rather than defended against downstream.
  const { text, report } = prepareText(rawText, {
    expandTabs: !deps.literalTabs,
    tabWidth: deps.tabWidth,
    foldTypographic: deps.backend.layoutSafe !== true,
  });
  deps.onPrepared?.(report);

  const total = text.length;
  const guardIndent = deps.guardIndent ?? looksIndented(text);

  // Start from a known-clean modifier state. If a previous run or a dropped
  // remote key-up left one latched, every character below would be a shortcut.
  await deps.backend.releaseAll?.();

  const delay = (): number => {
    const jitter = (rng() * 2 - 1) * profile.jitterMs;
    return Math.max(0, Math.round(profile.baseDelayMs + jitter));
  };

  try {
    return await typeLoop();
  } finally {
    // Whatever happened -- finished, cancelled, or threw part-way through a
    // modifier combo -- the machine is handed back with nothing held down.
    await deps.backend.releaseAll?.().catch(() => {});
  }

  async function typeLoop(): Promise<boolean> {
  for (let i = 0; i < text.length; i++) {
    if (deps.signal?.aborted) return false; // cancelled before this keystroke
    const ch = text[i];

    // Only reachable with literalTabs on; otherwise prepareText already turned
    // tabs into spaces.
    if (ch === "\t") {
      await deps.backend.pressTab?.();
      hooks.onProgress?.(i + 1, total);
      if (i < text.length - 1) await sleep(delay());
      continue;
    }

    // Line breaks are key presses, not characters. Swallow the CR of a CRLF
    // pair so "\r\n" produces a single Return rather than two.
    if (ch === "\r" && text[i + 1] === "\n") {
      hooks.onProgress?.(i + 1, total);
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      await deps.backend.pressEnter();
      // Select whatever the editor auto-inserted, so this line's own leading
      // whitespace replaces it rather than stacking on top of it. Harmless
      // when the editor inserted nothing: the selection is simply empty.
      if (guardIndent) await deps.backend.selectToLineStart?.();
      hooks.onProgress?.(i + 1, total);
      if (i < text.length - 1) await sleep(delay());
      continue;
    }

    // Occasionally fumble: type an adjacent wrong key, then fix it.
    if (rng() < profile.typoRate) {
      const wrong = pickTypo(ch, rng);
      if (wrong) {
        await deps.backend.typeChar(wrong);
        await sleep(delay());
        await deps.backend.backspace();
        await sleep(delay());
      }
    }

    await deps.backend.typeChar(ch);
    hooks.onProgress?.(i + 1, total);

    if (i < text.length - 1) await sleep(delay());
  }
  return true;
  }
}
