import { platform } from "node:os";
import type { TypingBackend } from "./index.js";

/**
 * Real TypingBackend backed by nut-js. Lazily imports the native module so unit
 * tests never load it.
 */
export async function createNutTypingBackend(): Promise<TypingBackend> {
  const nut = await import("@nut-tree-fork/nut-js");
  const { keyboard, Key } = nut;
  keyboard.config.autoDelayMs = 0;

  return {
    async typeChar(ch: string): Promise<void> {
      await keyboard.type(ch);
    },
    async backspace(): Promise<void> {
      await keyboard.pressKey(Key.Backspace);
      await keyboard.releaseKey(Key.Backspace);
    },
    async pressEnter(): Promise<void> {
      await keyboard.pressKey(Key.Enter);
      await keyboard.releaseKey(Key.Enter);
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
      const combo =
        platform() === "darwin"
          ? [Key.LeftShift, Key.LeftCmd, Key.Left]
          : [Key.LeftShift, Key.Home];
      for (const k of combo) await keyboard.pressKey(k);
      for (const k of [...combo].reverse()) await keyboard.releaseKey(k);
    },
  };
}
