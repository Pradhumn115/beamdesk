import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline";
import type { TypingBackend } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// agent/{src,dist}/autotyper -> agent/native/win-typer.ps1
const HELPER = join(__dirname, "..", "..", "native", "win-typer.ps1");

/** Windows virtual-key codes for the few non-character keys we press. */
const VK = {
  back: 0x08,
  tab: 0x09,
  return: 0x0d,
  shift: 0x10,
  home: 0x24,
} as const;

/** How long to wait for a single keystroke to be acknowledged. */
const ACK_TIMEOUT_MS = 5_000;
/** How long to wait for the helper to finish compiling its P/Invoke type. */
const READY_TIMEOUT_MS = 30_000;

/**
 * TypingBackend for Windows that types through SendInput with
 * KEYEVENTF_UNICODE, via the PowerShell helper in agent/native/win-typer.ps1.
 *
 * This exists because nut-js must NOT be used to type text on Windows. Its
 * keyboard.type() reaches libnut's typeString(), which resolves each character
 * with VkKeyScan() and then presses whatever modifiers the lookup reports --
 * Ctrl and Alt included. Characters missing from the active layout report -1,
 * which libnut reads as "Shift+Ctrl+Alt"; AltGr characters (`{}[]\|@~` on most
 * non-US layouts) genuinely report Ctrl+Alt; and libnut truncates the code
 * point to 8 bits first, so `-` (U+2014) lands on VK 0x14 and anything
 * congruent to 0x54 lands on VK_T. In a browser those are accelerators:
 * Ctrl+T opens a tab, Ctrl+W closes one, and Ctrl+Shift silently switches the
 * keyboard layout, corrupting every character that follows.
 *
 * KEYEVENTF_UNICODE carries the code unit in wScan with wVk = 0. No layout
 * lookup, no modifier press, and immunity to Caps Lock -- so no character can
 * ever turn into a shortcut.
 *
 * Falls back to null if PowerShell or the helper script is unavailable, so the
 * caller can drop back to the nut-js backend rather than lose autotyping.
 */
export async function createWindowsTypingBackend(): Promise<TypingBackend | null> {
  if (process.platform !== "win32") return null;
  if (!existsSync(HELPER)) {
    process.stderr.write(`[autotype] win-typer helper missing at ${HELPER}\n`);
    return null;
  }

  let child: ChildProcess;
  try {
    child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
  } catch (err) {
    process.stderr.write(`[autotype] could not start win-typer (${String(err)})\n`);
    return null;
  }

  const stdin = child.stdin;
  const stdout = child.stdout;
  if (!stdin || !stdout) {
    child.kill();
    return null;
  }

  const lines: Interface = createInterface({ input: stdout });
  // Commands are strictly serial -- the autotyper awaits each keystroke -- so a
  // single pending waiter is enough, and it doubles as the backpressure that
  // stops us outrunning the helper.
  let pending: ((line: string | null) => void) | null = null;
  let dead = false;

  lines.on("line", (line) => {
    const waiter = pending;
    pending = null;
    waiter?.(line);
  });

  const die = (): void => {
    dead = true;
    const waiter = pending;
    pending = null;
    waiter?.(null);
  };
  child.on("exit", die);
  child.on("error", die);

  const nextLine = (timeoutMs: number): Promise<string | null> =>
    new Promise((resolve) => {
      if (dead) return resolve(null);
      const timer = setTimeout(() => {
        if (pending === settle) pending = null;
        resolve(null);
      }, timeoutMs);
      const settle = (line: string | null): void => {
        clearTimeout(timer);
        resolve(line);
      };
      pending = settle;
    });

  const ready = await nextLine(READY_TIMEOUT_MS);
  if (ready?.trim() !== "READY") {
    process.stderr.write("[autotype] win-typer did not report ready; using nut-js\n");
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    return null;
  }

  async function send(command: string): Promise<void> {
    if (dead) throw new Error("win-typer helper exited");
    stdin!.write(`${command}\n`);
    const ack = await nextLine(ACK_TIMEOUT_MS);
    if (ack === null) throw new Error(`win-typer did not acknowledge "${command}"`);
    if (ack.startsWith("E ")) throw new Error(`win-typer: ${ack.slice(2)}`);
  }

  return {
    async typeChar(ch: string): Promise<void> {
      // Send the UTF-16 code units as they are: a surrogate pair travels as two
      // units in one command so the helper puts both down before either comes
      // up, which is what makes an astral character arrive as one character.
      const units: string[] = [];
      for (let i = 0; i < ch.length; i++) units.push(ch.charCodeAt(i).toString(16));
      if (units.length === 0) return;
      await send(`U ${units.join(" ")}`);
    },
    async backspace(): Promise<void> {
      await send(`T ${VK.back.toString(16)}`);
    },
    async pressEnter(): Promise<void> {
      await send(`T ${VK.return.toString(16)}`);
    },
    async pressTab(): Promise<void> {
      await send(`T ${VK.tab.toString(16)}`);
    },
    async selectToLineStart(): Promise<void> {
      // Shift+Home. Released in reverse in a finally, so a failure part-way
      // through can never leave Shift latched -- a latched modifier turns every
      // subsequent keystroke into a shortcut.
      await send(`D ${VK.shift.toString(16)}`);
      try {
        await send(`T ${VK.home.toString(16)}`);
      } finally {
        await send(`P ${VK.shift.toString(16)}`);
      }
    },
    async releaseAll(): Promise<void> {
      // Nothing is ever left held by this backend (every press has a finally),
      // but Shift is cheap insurance against a helper restart mid-combo.
      await send(`P ${VK.shift.toString(16)}`).catch(() => {});
    },
    dispose(): void {
      try {
        stdin!.end();
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
