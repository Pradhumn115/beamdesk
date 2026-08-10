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
  };
}
