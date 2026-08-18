import type { InputBackend, ScreenSize } from "./index.js";

type Modifier = "ctrl" | "alt" | "shift" | "meta";

export interface NutBackendOptions {
  /**
   * Layout-independent character typer, used instead of nut-js for printable
   * characters when one is available.
   *
   * On Windows nut-js resolves every character through VkKeyScan() and presses
   * the modifiers that lookup reports. Punctuation that sits on AltGr in a
   * non-US layout -- `{}[]\|@~`, so most of any code sample -- therefore
   * arrives as Ctrl+Alt+key, and a character the layout lacks arrives as
   * Shift+Ctrl+Alt plus an arbitrary virtual key. Ctrl+T opens a browser tab.
   * See autotyper/winTyping.ts for the full account.
   */
  typeChar?: (ch: string) => Promise<void>;
}

/**
 * How far a single wheel message may scroll, in nut-js scroll units.
 *
 * Browsers report wheel deltas in pixels -- a trackpad flick is easily several
 * hundred -- while nut-js counts detents. Forwarding the raw number scrolls the
 * target by hundreds of lines from one gesture.
 */
const MAX_SCROLL_UNITS = 10;
const SCROLL_PIXELS_PER_UNIT = 40;

/**
 * Real InputBackend backed by @nut-tree-fork/nut-js. nut-js is imported lazily
 * so that unit tests (which use a fake backend) never load the native module.
 */
export async function createNutBackend(
  options: NutBackendOptions = {},
): Promise<InputBackend> {
  const nut = await import("@nut-tree-fork/nut-js");
  const { mouse, keyboard, screen, Point, Button, Key } = nut;

  // Disable nut-js's own inter-keystroke delay; we manage timing ourselves.
  keyboard.config.autoDelayMs = 0;
  mouse.config.autoDelayMs = 0;

  const buttonMap: Record<"left" | "right" | "middle", number> = {
    left: Button.LEFT,
    right: Button.RIGHT,
    middle: Button.MIDDLE,
  };

  // Browser key name -> nut-js Key. Only special / non-printable keys need this;
  // printable characters go through typeChar().
  const keyMap: Record<string, number> = {
    // Key.Return, not Key.Enter: libnut maps "enter" to the numeric keypad's
    // Enter on macOS (kVK_ANSI_KeypadEnter), which some targets treat
    // differently from Return.
    Enter: Key.Return,
    Backspace: Key.Backspace,
    Tab: Key.Tab,
    Escape: Key.Escape,
    " ": Key.Space,
    ArrowLeft: Key.Left,
    ArrowRight: Key.Right,
    ArrowUp: Key.Up,
    ArrowDown: Key.Down,
    Delete: Key.Delete,
    Home: Key.Home,
    End: Key.End,
    PageUp: Key.PageUp,
    PageDown: Key.PageDown,
    Control: Key.LeftControl,
    Alt: Key.LeftAlt,
    Shift: Key.LeftShift,
    Meta: Key.LeftSuper,
    CapsLock: Key.CapsLock,
    F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
    F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
  };

  /**
   * Punctuation that has a named key, so a combination involving it resolves to
   * a real key press.
   *
   * Without these, resolveKey() returned null for anything like "/" or "[" and
   * the caller fell through to typing the bare character -- silently dropping
   * the modifiers, so Ctrl+/ (comment a line) arrived as a literal "/".
   * Shifted forms map to the same physical key; the modifier list carries the
   * Shift.
   */
  const punctuation: Record<string, number> = {
    "`": Key.Grave, "~": Key.Grave,
    "-": Key.Minus, _: Key.Minus,
    "=": Key.Equal, "+": Key.Equal,
    "[": Key.LeftBracket, "{": Key.LeftBracket,
    "]": Key.RightBracket, "}": Key.RightBracket,
    "\\": Key.Backslash, "|": Key.Backslash,
    ";": Key.Semicolon, ":": Key.Semicolon,
    "'": Key.Quote, '"': Key.Quote,
    ",": Key.Comma, "<": Key.Comma,
    ".": Key.Period, ">": Key.Period,
    "/": Key.Slash, "?": Key.Slash,
  };

  const modifierKey: Record<Modifier, number> = {
    ctrl: Key.LeftControl,
    alt: Key.LeftAlt,
    shift: Key.LeftShift,
    meta: Key.LeftSuper,
  };

  /**
   * Keys currently held down by this backend, in press order.
   *
   * The remote client cannot be relied on to deliver every key-up. macOS never
   * fires keyup for ordinary keys while Command is held, a browser tab that
   * loses focus mid-keystroke fires none at all, and the character a key
   * reports can differ between its own keydown and keyup -- so a key-up may
   * arrive naming a key that was never pressed. Any of those leaves a modifier
   * down for the lifetime of the process, and from then on every keystroke,
   * autotyped ones included, is a shortcut.
   *
   * The ledger is what makes recovery possible. It has to be exact: libnut
   * clears a modifier by XOR-ing it out of a process-global accumulator, so
   * releasing one that is not held *sets* it. Blanket-releasing would create
   * the fault it was meant to clear.
   */
  const heldKeys: number[] = [];
  const heldButtons: number[] = [];

  async function pressKey(key: number): Promise<void> {
    await keyboard.pressKey(key);
    heldKeys.push(key);
  }

  async function releaseKey(key: number): Promise<void> {
    await keyboard.releaseKey(key);
    const at = heldKeys.lastIndexOf(key);
    if (at !== -1) heldKeys.splice(at, 1);
  }

  function resolveKey(name: string): number | null {
    if (name in keyMap) return keyMap[name];
    if (name in punctuation) return punctuation[name];
    if (name.length === 1) {
      const upper = name.toUpperCase();
      if (upper >= "A" && upper <= "Z") return Key[upper as keyof typeof Key] as number;
      if (name >= "0" && name <= "9") {
        return Key[`Num${name}` as keyof typeof Key] as number;
      }
    }
    return null;
  }

  const typeChar =
    options.typeChar ??
    (async (ch: string): Promise<void> => {
      await keyboard.type(ch);
    });

  /** Clamp a browser wheel delta to a sane number of scroll detents. */
  function scrollUnits(delta: number): number {
    const units = Math.round(Math.abs(delta) / SCROLL_PIXELS_PER_UNIT) || (delta === 0 ? 0 : 1);
    return Math.min(MAX_SCROLL_UNITS, units);
  }

  return {
    async screenSize(): Promise<ScreenSize> {
      const [width, height] = await Promise.all([screen.width(), screen.height()]);
      return { width, height };
    },

    async moveMouse(x: number, y: number): Promise<void> {
      await mouse.setPosition(new Point(x, y));
    },

    async mouseButton(action, button): Promise<void> {
      const b = buttonMap[button];
      if (action === "down") {
        await mouse.pressButton(b);
        heldButtons.push(b);
      } else if (action === "up") {
        await mouse.releaseButton(b);
        const at = heldButtons.lastIndexOf(b);
        if (at !== -1) heldButtons.splice(at, 1);
      } else {
        await mouse.click(b);
      }
    },

    async scroll(dx, dy): Promise<void> {
      if (dy > 0) await mouse.scrollDown(scrollUnits(dy));
      else if (dy < 0) await mouse.scrollUp(scrollUnits(dy));
      if (dx > 0) await mouse.scrollRight(scrollUnits(dx));
      else if (dx < 0) await mouse.scrollLeft(scrollUnits(dx));
    },

    async keyAction(action, key, modifiers): Promise<void> {
      const mods = modifiers.map((m) => modifierKey[m]);

      // Fast path: a printable character with no modifiers -> type it directly.
      if (action === "press" && mods.length === 0 && key.length === 1 && !(key in keyMap)) {
        await typeChar(key);
        return;
      }

      const resolved = resolveKey(key);
      if (resolved === null) {
        // An unknown named key. Type it only if it is a single character AND no
        // modifier was requested: typing the bare character would drop the
        // modifiers silently, turning Ctrl+<key> into plain text with no sign
        // that the command was lost.
        if (key.length === 1 && mods.length === 0) await typeChar(key);
        return;
      }

      if (action === "down") {
        for (const m of mods) await pressKey(m);
        await pressKey(resolved);
      } else if (action === "up") {
        await releaseKey(resolved);
        for (const m of [...mods].reverse()) await releaseKey(m);
      } else {
        // A tap: press and release as one unit, so an error part-way through
        // still releases whatever went down.
        const pressed: number[] = [];
        try {
          for (const m of mods) {
            await pressKey(m);
            pressed.push(m);
          }
          await pressKey(resolved);
          pressed.push(resolved);
        } finally {
          for (const k of [...pressed].reverse()) await releaseKey(k).catch(() => {});
        }
      }
    },

    hasHeldKeys(): boolean {
      return heldKeys.length > 0 || heldButtons.length > 0;
    },

    async releaseAllHeld(): Promise<number> {
      const count = heldKeys.length + heldButtons.length;
      // Reverse order, and the key before its modifiers, so each key-up carries
      // the same modifier state its key-down did.
      for (const key of [...heldKeys].reverse()) {
        await releaseKey(key).catch(() => {});
      }
      for (const b of [...heldButtons].reverse()) {
        try {
          await mouse.releaseButton(b);
        } catch {
          /* best effort */
        }
      }
      heldKeys.length = 0;
      heldButtons.length = 0;
      return count;
    },
  };
}
