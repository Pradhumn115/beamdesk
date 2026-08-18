import type { KeyMessage, MouseMessage } from "@bcsa/shared";
import { toPixel } from "./coords.js";

export interface ScreenSize {
  width: number;
  height: number;
}

/**
 * Abstraction over the OS input backend so the controller can be unit-tested
 * without the native nut-js module. See createNutBackend() for the real one.
 */
export interface InputBackend {
  screenSize(): Promise<ScreenSize>;
  moveMouse(x: number, y: number): Promise<void>;
  mouseButton(action: "down" | "up" | "click", button: "left" | "right" | "middle"): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
  keyAction(
    action: "down" | "up" | "press",
    key: string,
    modifiers: Array<"ctrl" | "alt" | "shift" | "meta">,
  ): Promise<void>;
  /** Whether anything is currently held down by this backend. */
  hasHeldKeys?(): boolean;
  /** Release every held key and mouse button. Returns how many were released. */
  releaseAllHeld?(): Promise<number>;
}

export interface InputControllerOptions {
  /**
   * Release held keys after this long with no client input. Default 5s.
   *
   * A key-down with no matching key-up is not a rare edge case: macOS never
   * fires keyup for ordinary keys while Command is held, and a browser tab that
   * loses focus mid-keystroke fires none at all. Without a deadline the held
   * modifier persists for the life of the agent, and every keystroke after it
   * -- typed by the client or by the autotyper -- becomes a shortcut.
   */
  staleKeyMs?: number;
  /** Called when the watchdog releases keys, so the event can be logged. */
  onStaleRelease?: (count: number) => void;
  /** Injectable timer for tests; defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_STALE_KEY_MS = 5_000;

/**
 * Applies incoming client control messages to the OS via an InputBackend,
 * translating normalized coordinates to pixels using the cached screen size.
 */
export class InputController {
  private size: ScreenSize | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly staleKeyMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (t: ReturnType<typeof setTimeout>) => void;

  constructor(
    private readonly backend: InputBackend,
    private readonly options: InputControllerOptions = {},
  ) {
    this.staleKeyMs = options.staleKeyMs ?? DEFAULT_STALE_KEY_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((t) => clearTimeout(t));
  }

  async screenSize(): Promise<ScreenSize> {
    if (!this.size) this.size = await this.backend.screenSize();
    return this.size;
  }

  async applyMouse(msg: MouseMessage): Promise<void> {
    if (msg.action === "scroll") {
      await this.backend.scroll(msg.dx ?? 0, msg.dy ?? 0);
      return;
    }

    // Position first (if provided) so clicks land where the client aimed.
    if (typeof msg.x === "number" && typeof msg.y === "number") {
      const { width, height } = await this.screenSize();
      await this.backend.moveMouse(toPixel(msg.x, width), toPixel(msg.y, height));
    }

    if (msg.action === "move") return;
    await this.backend.mouseButton(msg.action, msg.button ?? "left");
    this.armWatchdog();
  }

  async applyKey(msg: KeyMessage): Promise<void> {
    await this.backend.keyAction(msg.action, msg.key, msg.modifiers ?? []);
    this.armWatchdog();
  }

  /**
   * Release everything the backend is holding.
   *
   * Called at every boundary where held state stops being meaningful: the
   * controlling client disconnects, an autotype run starts or finishes, or the
   * watchdog below decides the client has gone quiet mid-keystroke.
   */
  async releaseAllKeys(): Promise<number> {
    this.disarmWatchdog();
    return (await this.backend.releaseAllHeld?.()) ?? 0;
  }

  /** Stop the watchdog. Call on shutdown so a timer cannot outlive the agent. */
  stop(): void {
    this.disarmWatchdog();
  }

  private armWatchdog(): void {
    this.disarmWatchdog();
    if (!this.backend.hasHeldKeys?.()) return;
    this.watchdog = this.setTimer(() => {
      this.watchdog = null;
      void this.backend.releaseAllHeld?.().then((count) => {
        if (count > 0) this.options.onStaleRelease?.(count);
      });
    }, this.staleKeyMs);
  }

  private disarmWatchdog(): void {
    if (this.watchdog !== null) {
      this.clearTimer(this.watchdog);
      this.watchdog = null;
    }
  }
}
