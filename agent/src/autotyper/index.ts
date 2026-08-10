import type { AutotypeProfile } from "@bcsa/shared";

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
  text: string,
  profile: AutotypeProfile,
  deps: AutotypeDeps,
  hooks: AutotypeHooks = {},
): Promise<boolean> {
  const sleep = deps.sleep ?? defaultSleep;
  const rng = deps.rng ?? Math.random;
  const total = text.length;

  const delay = (): number => {
    const jitter = (rng() * 2 - 1) * profile.jitterMs;
    return Math.max(0, Math.round(profile.baseDelayMs + jitter));
  };

  for (let i = 0; i < text.length; i++) {
    if (deps.signal?.aborted) return false; // cancelled before this keystroke
    const ch = text[i];

    // Line breaks are key presses, not characters. Swallow the CR of a CRLF
    // pair so "\r\n" produces a single Return rather than two.
    if (ch === "\r" && text[i + 1] === "\n") {
      hooks.onProgress?.(i + 1, total);
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      await deps.backend.pressEnter();
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
