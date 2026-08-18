/**
 * Optional global hotkey (Ctrl+Alt+L by default) that toggles the input lock
 * from the agent side. Uses uiohook-napi for OS-wide key capture. The whole
 * thing is best-effort: if the native module isn't installed or fails to load,
 * we log once and continue without a hotkey — it must never take down the agent.
 *
 * Note: when the lock uses a full block (Windows BlockInput), physical keys are
 * suppressed, so the hotkey can turn the lock ON but not OFF. Turning it off is
 * handled by the client and the auto-release watchdog (see InputLockManager).
 */
export interface HotkeyHandle {
  stop(): void;
}

/**
 * Whether uIOhook.start() is safe to call, or the reason it is not.
 *
 * macOS refuses OS-wide key capture without Accessibility permission, and
 * libuiohook answers that refusal by calling abort() on its own hook thread:
 * it prints "hook_run [pid]: Accessibility API is disabled!" and takes the
 * process down with SIGABRT. That is asynchronous and native, so the try/catch
 * around start() below never sees it — the agent simply died at boot with exit
 * code 134, on any machine whose terminal had not been granted Accessibility.
 * A best-effort hotkey must not be able to do that, so the permission is
 * checked BEFORE the hook is ever started.
 *
 * Only a positive "authorized" clears it. If the check itself is unavailable we
 * decline rather than gamble, because the cost of guessing wrong is the whole
 * agent rather than one keyboard shortcut.
 */
/**
 * The sliver of @nut-tree-fork/node-mac-permissions this needs.
 *
 * Declared locally because the package is darwin-only and therefore absent on
 * the machines where this file still has to compile.
 */
interface MacPermissions {
  getAuthStatus(type: "accessibility" | "screen"): string;
}

async function hookBlockedBecause(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    // Imported through a variable so the specifier is not a literal.
    //
    // The package declares `"os": ["darwin"]`, so npm does not install it
    // anywhere else and tsc cannot resolve its types -- which broke the build
    // on Windows and Linux outright, on a line that never runs there. A
    // non-literal specifier is resolved at runtime only, which is exactly the
    // guarantee the platform check above already provides.
    const specifier = "@nut-tree-fork/node-mac-permissions";
    // CommonJS under an ESM import: the exports arrive on `.default`, and
    // reading getAuthStatus straight off the namespace silently found
    // `undefined` -- which landed in the catch below and declined the hotkey on
    // every Mac, including the ones that had granted the permission.
    const mod = (await import(specifier)) as MacPermissions & { default?: MacPermissions };
    const permissions = mod.default ?? mod;
    const status = permissions.getAuthStatus("accessibility");
    if (status === "authorized") return null;
    return `macOS Accessibility permission is "${status}" — grant it in System Settings › Privacy & Security › Accessibility`;
  } catch (err) {
    return `macOS Accessibility permission could not be checked (${String(err)})`;
  }
}

export interface HotkeyOptions {
  /**
   * Return true to ignore a trigger.
   *
   * uiohook watches the OS-wide key stream and cannot tell a physical key from
   * one the agent injected, so a Ctrl+Alt+L that the agent itself produced --
   * or a plain "l" typed while a latched Ctrl+Alt made it look like one --
   * would toggle the lock in the middle of a run. The caller knows when it is
   * driving the keyboard; this lets it say so.
   */
  suppressed?: () => boolean;
}

export async function registerLockHotkey(
  onToggle: () => void,
  options: HotkeyOptions = {},
): Promise<HotkeyHandle> {
  const blocked = await hookBlockedBecause();
  if (blocked) {
    process.stderr.write(
      `[inputlock] global hotkey unavailable: ${blocked}; use the client toggle instead.\n`,
    );
    return { stop() {} };
  }

  try {
    const mod = await import("uiohook-napi");
    const { uIOhook, UiohookKey } = mod;

    const onKeydown = (e: { keycode: number; ctrlKey: boolean; altKey: boolean }) => {
      if (options.suppressed?.()) return;
      if (e.ctrlKey && e.altKey && e.keycode === UiohookKey.L) onToggle();
    };
    uIOhook.on("keydown", onKeydown);
    uIOhook.start();
    process.stdout.write("Input-lock hotkey ready: Ctrl+Alt+L\n");

    return {
      stop() {
        try {
          uIOhook.off("keydown", onKeydown);
          uIOhook.stop();
        } catch {
          /* ignore */
        }
      },
    };
  } catch (err) {
    process.stderr.write(
      `[inputlock] global hotkey unavailable (${String(err)}); use the client toggle instead.\n`,
    );
    return { stop() {} };
  }
}
