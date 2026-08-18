import { platform } from "node:os";
import type { TypingBackend } from "./index.js";

/**
 * Real TypingBackend backed by nut-js. Lazily imports the native module so unit
 * tests never load it.
 *
 * Preferred only on macOS and Linux. On Windows use createWindowsTypingBackend
 * instead: nut-js resolves each character through VkKeyScan there and presses
 * whatever modifiers the lookup demands, which turns ordinary punctuation into
 * Ctrl and Alt shortcuts. See winTyping.ts for the full account.
 */
export async function createNutTypingBackend(): Promise<TypingBackend> {
  const nut = await import("@nut-tree-fork/nut-js");
  const { keyboard, Key } = nut;
  keyboard.config.autoDelayMs = 0;

  const isMac = platform() === "darwin";

  // Keys this backend has pressed and not yet released, in press order.
  //
  // libnut releases a modifier by XOR-ing it out of a process-global flag
  // accumulator, so releasing one that was never pressed *sets* it instead of
  // clearing it. A blanket "release everything" would therefore create the
  // exact latched-modifier state it was meant to prevent -- the ledger exists
  // so releaseAll() can release precisely what is actually down.
  const held: number[] = [];

  async function press(key: number): Promise<void> {
    await keyboard.pressKey(key);
    held.push(key);
  }

  async function release(key: number): Promise<void> {
    await keyboard.releaseKey(key);
    const at = held.lastIndexOf(key);
    if (at !== -1) held.splice(at, 1);
  }

  /** Press a combination and release it in reverse, even if a step throws. */
  async function chord(keys: number[]): Promise<void> {
    const pressed: number[] = [];
    try {
      for (const k of keys) {
        await press(k);
        pressed.push(k);
      }
    } finally {
      for (const k of [...pressed].reverse()) {
        // Each release is independent: one failure must not strand the rest,
        // because whatever stays down modifies every keystroke that follows.
        await release(k).catch(() => {});
      }
    }
  }

  return {
    // macOS delivers characters through CGEventKeyboardSetUnicodeString, which
    // never consults the layout. Every other platform's libnut path does.
    layoutSafe: isMac,

    async typeChar(ch: string): Promise<void> {
      await keyboard.type(ch);
    },
    async backspace(): Promise<void> {
      await chord([Key.Backspace]);
    },
    async pressEnter(): Promise<void> {
      // Key.Return, not Key.Enter: libnut maps "enter" to kVK_ANSI_KeypadEnter
      // on macOS -- the numeric keypad's Enter, which some targets treat
      // differently from Return. "return" is kVK_Return on macOS and VK_RETURN
      // on Windows, so this is the right key everywhere.
      await chord([Key.Return]);
    },
    async pressTab(): Promise<void> {
      await chord([Key.Tab]);
    },
    /**
     * Select back to the line start, using whatever that platform binds it to.
     *
     * No configuration needed: the keystrokes land on the agent's own machine,
     * so the agent's platform IS the target's platform. macOS puts line-start
     * on Cmd+Left (Home means document start in many apps); Windows and Linux
     * use Home.
     */
    async selectToLineStart(): Promise<void> {
      await chord(isMac ? [Key.LeftShift, Key.LeftCmd, Key.Left] : [Key.LeftShift, Key.Home]);
    },
    async releaseAll(): Promise<void> {
      for (const key of [...held].reverse()) {
        await release(key).catch(() => {});
      }
    },
  };
}
