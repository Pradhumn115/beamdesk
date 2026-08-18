import { useEffect, useRef } from "react";
import type { ClientMessage } from "@bcsa/shared";
import type { ContentRect } from "../view/ScreenView";
import { mapPointerToNormalized } from "./mapCoords";

type Modifier = "ctrl" | "alt" | "shift" | "meta";
type SendFn = (msg: ClientMessage) => void;
type ControlSurface = HTMLCanvasElement | HTMLVideoElement;

// Throttle mousemove to ~50/s to avoid flooding the socket.
const MOVE_INTERVAL_MS = 20;

/**
 * Delay after forwarding Ctrl/Cmd+C or +X before fetching the agent's
 * clipboard. The OS needs a moment to actually populate its clipboard after
 * the keypress lands — this is a real OS-level delay, not network latency,
 * so it's needed even on an instant local connection.
 */
const CLIPBOARD_COPY_FETCH_DELAY_MS = 200;

/**
 * Delay between sending setClipboard and forwarding Ctrl/Cmd+V's own
 * keystroke, so the agent applies the new clipboard content before the
 * paste happens.
 *
 * Not relying on the two messages' send order alone: the agent dispatches
 * each incoming message via a fire-and-forget call (see onControlMessage's
 * call site), not one awaited before the next is handled, so two native
 * calls (clipboard set vs. key press) racing on the agent's side could
 * finish in either order with no gap at all between the sends.
 */
const CLIPBOARD_PASTE_DELAY_MS = 150;

const buttonName = (button: number): "left" | "middle" | "right" => {
  switch (button) {
    case 1:
      return "middle";
    case 2:
      return "right";
    default:
      return "left";
  }
};

function collectModifiers(e: KeyboardEvent): Modifier[] {
  const mods: Modifier[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey) mods.push("shift");
  if (e.metaKey) mods.push("meta");
  return mods;
}

/**
 * Convert a mouse event position into normalized 0..1 coordinates relative to
 * the *frame image* inside the canvas. The frame is letterboxed (centered, with
 * black bars), so we map against the actual image rectangle published by
 * ScreenView — not the whole canvas — otherwise clicks are offset and mis-scaled
 * whenever the screen's aspect ratio differs from the canvas's.
 */
export function normalizedCoords(
  canvas: ControlSurface,
  content: ContentRect,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return mapPointerToNormalized(clientX, clientY, rect, backingStoreOf(canvas, rect), content);
}

/**
 * The surface's pixel dimensions, falling back to its CSS box.
 *
 * Duck-typed rather than `instanceof HTMLCanvasElement`, which would throw a
 * ReferenceError anywhere the DOM globals are absent.
 */
function backingStoreOf(
  surface: ControlSurface,
  rect: DOMRect,
): { width: number; height: number } {
  const { width, height } = surface as { width?: number; height?: number };
  if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
    return { width, height };
  }
  return { width: rect.width, height: rect.height };
}

/**
 * What was sent for a key that is currently held down, so the release can name
 * the same key the press did.
 */
interface HeldKey {
  key: string;
  sentAt: number;
}

/**
 * Identity of a physical key, independent of the character it produces.
 *
 * `e.key` is the wrong thing to track a held key by: it carries the character,
 * and the character changes with the modifiers. Press Shift, then A, then
 * release Shift before A, and the keydown says "A" while the keyup says "a" --
 * two different keys as far as the agent is concerned, so the "A" it is holding
 * is never released. `e.code` names the physical key and does not move.
 */
const keyIdentity = (e: KeyboardEvent): string => e.code || e.key;

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

/**
 * Attaches mouse + keyboard handlers to a canvas element and translates them
 * into ClientMessages. `enabled` gates all input so the user can release
 * control. Keyboard events are captured only while the canvas is focused.
 */
export function useRemoteControl(
  canvasRef: React.RefObject<ControlSurface>,
  contentRectRef: React.MutableRefObject<ContentRect>,
  send: SendFn,
  enabled: boolean,
  getClipboard: () => void,
  setClipboard: () => Promise<void>,
): void {
  // Keep the latest send/enabled in refs so listeners stay stable.
  const sendRef = useRef<SendFn>(send);
  const enabledRef = useRef<boolean>(enabled);
  const lastMoveRef = useRef<number>(0);
  // Keys the agent is currently holding on our behalf, by physical key.
  //
  // The agent cannot recover on its own from a key-down we never follow with a
  // key-up: a held modifier makes every later keystroke a shortcut, autotyped
  // ones included. Three things routinely eat our key-ups, so we track what we
  // sent and release it explicitly.
  const heldRef = useRef<Map<string, HeldKey>>(new Map());
  const getClipboardRef = useRef(getClipboard);
  const setClipboardRef = useRef(setClipboard);

  useEffect(() => {
    sendRef.current = send;
  }, [send]);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useEffect(() => {
    getClipboardRef.current = getClipboard;
  }, [getClipboard]);
  useEffect(() => {
    setClipboardRef.current = setClipboard;
  }, [setClipboard]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const markHeld = (e: KeyboardEvent) => {
      heldRef.current.set(keyIdentity(e), { key: e.key, sentAt: Date.now() });
    };

    /**
     * Tell the agent to release keys we are holding, and forget them.
     *
     * Sent as plain key-ups rather than trusting the agent to time them out,
     * because until they arrive every keystroke the machine sees -- including
     * one the agent types itself -- carries the stuck modifier.
     */
    const releaseHeld = (predicate: (held: HeldKey) => boolean = () => true) => {
      for (const [id, held] of [...heldRef.current]) {
        if (!predicate(held)) continue;
        heldRef.current.delete(id);
        sendRef.current({ type: "key", action: "up", key: held.key, modifiers: [] });
      }
    };

    // Focus loss is the common way a key-up goes missing: Cmd-Tab or Alt-Tab
    // away and the browser delivers the keydown but never the keyup, leaving
    // the agent holding a modifier with nothing left to release it.
    const onBlur = () => releaseHeld();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") releaseHeld();
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!enabledRef.current) return;
      const now = performance.now();
      if (now - lastMoveRef.current < MOVE_INTERVAL_MS) return;
      lastMoveRef.current = now;
      const { x, y } = normalizedCoords(canvas, contentRectRef.current, e.clientX, e.clientY);
      sendRef.current({ type: "mouse", action: "move", x, y });
    };

    const onMouseDown = (e: MouseEvent) => {
      if (!enabledRef.current) return;
      canvas.focus();
      const { x, y } = normalizedCoords(canvas, contentRectRef.current, e.clientX, e.clientY);
      sendRef.current({
        type: "mouse",
        action: "down",
        x,
        y,
        button: buttonName(e.button),
      });
    };

    const onMouseUp = (e: MouseEvent) => {
      if (!enabledRef.current) return;
      const { x, y } = normalizedCoords(canvas, contentRectRef.current, e.clientX, e.clientY);
      sendRef.current({
        type: "mouse",
        action: "up",
        x,
        y,
        button: buttonName(e.button),
      });
    };

    // We forward only raw down/up/move (the RFB/VNC model): the agent OS turns
    // press+release into a click, rapid press/release/press/release into a
    // double-click, and press+move+release into a drag. We deliberately do NOT
    // also send the browser's synthesized `click`/`dblclick`/`contextmenu`
    // events — doing so would actuate every button a second time (a single
    // click would fire twice, a right-click would open the menu twice, etc.).

    const onContextMenu = (e: MouseEvent) => {
      if (!enabledRef.current) return;
      // Only stop the browser's own context menu; the right-button down/up
      // already sent via onMouseDown/onMouseUp produces the remote right-click.
      e.preventDefault();
    };

    const onWheel = (e: WheelEvent) => {
      if (!enabledRef.current) return;
      e.preventDefault();
      sendRef.current({
        type: "mouse",
        action: "scroll",
        dx: e.deltaX,
        dy: e.deltaY,
      });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;
      // Stop browser shortcuts (Cmd/Ctrl+key, Tab, etc.) while focused.
      e.preventDefault();
      const modifiers = collectModifiers(e);
      const key = e.key.toLowerCase();
      // Ctrl on Windows/Linux, Cmd on Mac — whichever this browser's OS uses.
      const isClipboardCombo = (modifiers.includes("ctrl") || modifiers.includes("meta")) && !e.repeat;

      if (isClipboardCombo && (key === "c" || key === "x")) {
        markHeld(e);
        sendRef.current({ type: "key", action: "down", key: e.key, modifiers });
        window.setTimeout(() => getClipboardRef.current(), CLIPBOARD_COPY_FETCH_DELAY_MS);
        return;
      }

      if (isClipboardCombo && key === "v") {
        // Push this browser's clipboard to the agent first, then forward the
        // paste keystroke — see CLIPBOARD_PASTE_DELAY_MS for why a delay is
        // needed even after the send.
        markHeld(e);
        void setClipboardRef.current().finally(() => {
          window.setTimeout(
            () => sendRef.current({ type: "key", action: "down", key: e.key, modifiers }),
            CLIPBOARD_PASTE_DELAY_MS,
          );
        });
        return;
      }

      markHeld(e);
      sendRef.current({ type: "key", action: "down", key: e.key, modifiers });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!enabledRef.current) return;
      e.preventDefault();
      const id = keyIdentity(e);
      // Release the key we actually pressed, not the character this event
      // reports -- releasing Shift first rewrites "A" into "a".
      const key = heldRef.current.get(id)?.key ?? e.key;
      heldRef.current.delete(id);

      // No modifiers on a release. They are held by their own key-downs and
      // will be released by their own key-ups; naming them here would release
      // them early, while the user is still holding them -- and on macOS
      // libnut clears a modifier by XOR, so releasing one that is not held
      // sets it instead.
      const doSend = () => {
        sendRef.current({ type: "key", action: "up", key, modifiers: [] });
        // macOS does not deliver keyup for ordinary keys while Command is
        // held, so by the time Command itself comes up, every key pressed
        // during it is still down as far as the agent knows. Release them now
        // or they stay down forever.
        if (e.key === "Meta") releaseHeld((h) => !MODIFIER_KEYS.has(h.key));
      };

      // Paste's keydown above is deliberately delayed until setClipboard has
      // gone out. The physical keyup for the same keystroke fires on its own
      // schedule (whenever the user releases the key) and isn't part of that
      // delay chain, so without also delaying it here, "key up v" could reach
      // the agent before "key down v" — a key-up with no preceding key-down.
      // Releasing a key is always at or after pressing it, so adding the same
      // delay to both preserves their order.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        window.setTimeout(doSend, CLIPBOARD_PASTE_DELAY_MS);
        return;
      }
      doSend();
    };

    (canvas as HTMLElement).addEventListener("mousemove", onMouseMove);
    (canvas as HTMLElement).addEventListener("mousedown", onMouseDown);
    (canvas as HTMLElement).addEventListener("mouseup", onMouseUp);
    (canvas as HTMLElement).addEventListener("contextmenu", onContextMenu);
    (canvas as HTMLElement).addEventListener("wheel", onWheel, { passive: false });
    (canvas as HTMLElement).addEventListener("keydown", onKeyDown);
    (canvas as HTMLElement).addEventListener("keyup", onKeyUp);
    (canvas as HTMLElement).addEventListener("blur", onBlur);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      // Unmounting with keys held would strand them on the agent.
      releaseHeld();
      (canvas as HTMLElement).removeEventListener("mousemove", onMouseMove);
      (canvas as HTMLElement).removeEventListener("mousedown", onMouseDown);
      (canvas as HTMLElement).removeEventListener("mouseup", onMouseUp);
      (canvas as HTMLElement).removeEventListener("contextmenu", onContextMenu);
      (canvas as HTMLElement).removeEventListener("wheel", onWheel);
      (canvas as HTMLElement).removeEventListener("keydown", onKeyDown);
      (canvas as HTMLElement).removeEventListener("keyup", onKeyUp);
      (canvas as HTMLElement).removeEventListener("blur", onBlur);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [canvasRef]);

  // Giving up control mid-keystroke must not leave the agent holding the key:
  // the handlers above stop firing the moment `enabled` goes false, so the
  // key-up would never be sent.
  useEffect(() => {
    if (enabled) return;
    const held = heldRef.current;
    for (const [, entry] of held) {
      send({ type: "key", action: "up", key: entry.key, modifiers: [] });
    }
    held.clear();
  }, [enabled, send]);
}
