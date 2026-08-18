# Why autotyping opened new tabs, and what now stops it

Autotyped text sometimes stopped being text. A run would open a browser tab,
close one, navigate back, or fire some other shortcut, with nobody touching a
keyboard at either end. This is what was actually happening.

## The cause on Windows

nut-js does not send Unicode on Windows. `keyboard.type()` reaches libnut's
`typeString()`, which resolves every character through `VkKeyScan()` and then
presses whatever modifiers that lookup reports:

```c
MMKeyCode keyCodeForChar(const char c) { return VkKeyScan(c); }   // win32/keycode.c

int modifiers = keyCode >> 8;                       // high byte = shift state
if ((modifiers & 1) != 0) flags |= MOD_SHIFT;
if ((modifiers & 2) != 0) flags |= MOD_CONTROL;     // real Ctrl keydown
if ((modifiers & 4) != 0) flags |= MOD_ALT;         // real Alt keydown
keyCode = keyCode & 0xff;
```

Three ways that fires an accelerator:

1. **The code point is truncated to 8 bits** before the lookup —
   `toggleUniKey((char)n, ...)`. `—` (U+2014) lands on VK `0x14`, `’` (U+2019)
   on `0x19`, and anything congruent to `0x54` on **VK_T**.
2. **`VkKeyScan` returns `-1`** for any character absent from the active
   layout. That is `0xFFFF`, so `modifiers` is `0xFF` — **Shift and Ctrl and
   Alt together**, with virtual key `0xFF`.
3. **AltGr characters legitimately report Ctrl+Alt.** On German, Polish,
   Nordic, Turkish and Spanish layouts those are `{ } [ ] \ | @ ~` — which is
   most of any code sample.

In a browser: Ctrl+T opens a tab, Ctrl+W closes one, Ctrl+N opens a window. And
**Ctrl+Shift is Windows' own keyboard-layout switch**, so one bad character can
change the layout mid-run and corrupt every character after it. The dependence
on which characters appear in the text is why it looked intermittent.

## The cause on macOS

Different mechanism, same outcome. libnut keeps a **process-global modifier
accumulator** and clears it by XOR:

```c
if (down) { activeKeyFlags = flags | flagBuffer; flagBuffer |= activeKeyFlags; }
else      { activeKeyFlags = flags ^ flagBuffer; flagBuffer ^= flags; }
```

A key-down with no matching key-up therefore latches its modifier for the life
of the agent process — and a real Command keydown stays un-released at the HID
layer. Characters are then typed with
`CGEventCreateKeyboardEvent(src, 0, down)` from a
`kCGEventSourceStateHIDSystemState` source, which never calls `CGEventSetFlags`
and so **inherits the latched modifier**. Typing `t` becomes ⌘T.

Key-ups go missing routinely, and none of it requires user error:

- macOS **never fires `keyup` for ordinary keys while Command is held**
  ([Mozilla 1299553](https://bugzilla.mozilla.org/show_bug.cgi?id=1299553),
  [noVNC #1695](https://github.com/novnc/noVNC/issues/1695)).
- A browser tab that loses focus mid-keystroke fires no `keyup` at all.
- `e.key` carries the *character*, which changes with the modifiers — a key
  pressed as `A` can be released as `a`, so the release names a key that was
  never pressed.

The XOR is also a trap for the obvious fix: releasing a modifier that is **not**
held *sets* it. A blanket "release everything" would create the exact fault it
was meant to clear. Recovery has to release precisely what is actually down,
which is why there is a ledger.

## What changed

| Fix | Where |
|---|---|
| Type via `SendInput` + `KEYEVENTF_UNICODE` on Windows — no layout lookup, no modifier, immune to Caps Lock | `agent/native/win-typer.ps1`, `autotyper/winTyping.ts` |
| Remote keystrokes use the same safe typer | `input/nutBackend.ts` |
| Exact ledger of held keys and mouse buttons, with `releaseAllHeld()` | `input/nutBackend.ts` |
| Release at every boundary: client disconnect, autotype start and finish, shutdown | `connection/index.ts` |
| Watchdog releases keys held with no matching key-up after 5s | `input/index.ts` |
| Client tracks held keys by `e.code`, releases on blur / tab hidden / control released / unmount, and synthesises the key-ups macOS swallows under ⌘ | `client/src/control/useRemoteControl.ts` |
| Key-up no longer re-sends still-held modifiers (which released them early, and on macOS re-set them) | `client/src/control/useRemoteControl.ts` |
| Tabs expand to spaces by default — a Tab keystroke moves focus in a browser, and everything after it lands on the page body as bare-key shortcuts | `autotyper/textPrep.ts` |
| Control characters stripped; typographic lookalikes folded to ASCII for layout-resolving backends | `autotyper/textPrep.ts` |
| Remote key and mouse messages are dropped while a run is in progress, so a stray client keystroke cannot interleave | `connection/index.ts` |
| Every modifier combination presses and releases in a `finally` | `autotyper/nutTyping.ts`, `input/nutBackend.ts` |
| `Key.Return`, not `Key.Enter` — libnut maps "enter" to the numeric keypad's Enter on macOS | `autotyper/nutTyping.ts`, `input/nutBackend.ts` |
| Punctuation resolves to named keys, so `Ctrl+/` is no longer sent as a bare `/` with the modifier silently dropped | `input/nutBackend.ts` |
| Wheel deltas clamped — browsers report pixels, nut-js counts detents | `input/nutBackend.ts` |
| The lock hotkey ignores triggers during a run, since uiohook cannot tell an injected key from a physical one | `inputlock/hotkey.ts` |

## What was investigated and cleared

- **The auto-indent guard.** On Windows `selectToLineStart` presses Shift+Home,
  which is not an accelerator and cannot open a tab. It was a real hazard on
  macOS only (⌘← is Back with no text field focused), and is now exception-safe
  rather than removed.
- **`K_CMD` vs `K_META`.** Both are `kVK_Command`; there is no asymmetry
  between nut-js's `LeftCmd` and `LeftSuper` on macOS.
- **libnut's UTF-8 decoder.** The signed-`char` promotion in `typeString` is
  accidentally correct, because only the low bits of the lead byte are used.

## Not verified here

`agent/native/win-typer.ps1` was written and statically reviewed on macOS,
where PowerShell is unavailable. Its `SendInput` marshalling — in particular
that `INPUT` sizes to 40 bytes on x64, which it does only because the union
carries `MOUSEINPUT` — has not been executed. Run one autotype on Windows and
confirm "READY" appears before trusting it; the code falls back to nut-js with
a warning on stderr if the helper does not start.
