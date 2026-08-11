import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// agent/{src,dist}/display.* -> agent/native/bin/bcsa-inputlock-mac
const MAC_HELPER = join(__dirname, "..", "native", "bin", "bcsa-inputlock-mac");

const FALLBACK_HZ = 60;
const MIN_HZ = 24;
const MAX_HZ = 240;

let cached: number | null = null;

/**
 * Best-effort detection of the primary display's refresh rate (Hz). Used to
 * target the streaming frame rate at what the screen can actually show. Falls
 * back to 60 if detection fails. Result is cached (queried once per process).
 */
export function detectRefreshHz(): number {
  if (cached !== null) return cached;
  cached = clamp(probe()) ?? FALLBACK_HZ;
  return cached;
}

function clamp(hz: number | null): number | null {
  if (hz === null || !Number.isFinite(hz)) return null;
  if (hz < MIN_HZ || hz > MAX_HZ) return null;
  return Math.round(hz);
}

function probe(): number | null {
  try {
    switch (platform()) {
      case "darwin":
        return probeMac();
      case "win32":
        return probeWindows();
      default:
        return probeLinux();
    }
  } catch {
    return null;
  }
}

function probeMac(): number | null {
  // Preferred: our Swift helper via CVDisplayLink (accurate for built-in panels,
  // which system_profiler often omits and CGDisplayModeGetRefreshRate reports 0).
  if (existsSync(MAC_HELPER)) {
    const res = spawnSync(MAC_HELPER, ["refresh"], { encoding: "utf8", timeout: 5000 });
    const hz = Number((res.stdout ?? "").trim());
    if (Number.isFinite(hz) && hz > 0) return hz;
  }
  // Fallback: parse system_profiler if it happens to include a Hz line.
  const res = spawnSync("system_profiler", ["SPDisplaysDataType"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const rates = [...(res.stdout ?? "").matchAll(/(?:@\s*|Refresh Rate:\s*)([\d.]+)\s*Hz/gi)].map(
    (m) => Number(m[1]),
  );
  return rates.length ? Math.max(...rates) : null;
}

function probeWindows(): number | null {
  const res = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance -ClassName Win32_VideoController).CurrentRefreshRate",
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  const rates = (res.stdout ?? "")
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  return rates.length ? Math.max(...rates) : null;
}

function probeLinux(): number | null {
  // xrandr marks the active mode with '*': e.g. "1920x1080  60.00*+  59.94".
  const res = spawnSync("xrandr", ["--current"], { encoding: "utf8", timeout: 5000 });
  const rates = [...(res.stdout ?? "").matchAll(/([\d.]+)\*/g)].map((m) => Number(m[1]));
  return rates.length ? Math.max(...rates) : null;
}

/** A display's true pixel dimensions, as opposed to its logical/point size. */
export interface ScreenPixels {
  width: number;
  height: number;
}

let cachedPixels: ScreenPixels | null | undefined;

/**
 * Best-effort detection of the primary display's PHYSICAL pixel size.
 *
 * Distinct from the logical size the input backend reports, and the difference
 * is not cosmetic: on a Retina Mac `screenSize()` returns 1728x1117 for a
 * 3456x2234 panel, the capture device then hands back that same logical size,
 * and the encode width is clamped to it — so half the display's detail was
 * unreachable no matter how the encoder was configured. Windows and Linux
 * normally report pixels already, in which case this simply agrees with them.
 *
 * Returns null when detection fails, which leaves the device to choose as
 * before. Cached: queried once per process.
 */
export function detectScreenPixels(): ScreenPixels | null {
  if (cachedPixels !== undefined) return cachedPixels;
  cachedPixels = probePixels();
  return cachedPixels;
}

function probePixels(): ScreenPixels | null {
  try {
    switch (platform()) {
      case "darwin": {
        const res = spawnSync("system_profiler", ["SPDisplaysDataType"], {
          encoding: "utf8",
          timeout: 5000,
        });
        return parseMacPixels(res.stdout ?? "");
      }
      case "win32": {
        const res = spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance -ClassName Win32_VideoController) | " +
              "ForEach-Object { \"$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)\" }",
          ],
          { encoding: "utf8", timeout: 5000 },
        );
        return parseWindowsPixels(res.stdout ?? "");
      }
      default: {
        const res = spawnSync("xrandr", ["--current"], { encoding: "utf8", timeout: 5000 });
        return parseLinuxPixels(res.stdout ?? "");
      }
    }
  } catch {
    return null;
  }
}

/** Largest sane mode from a WxH list, so a multi-display machine picks the biggest. */
function largest(modes: ScreenPixels[]): ScreenPixels | null {
  const usable = modes.filter(
    (m) => Number.isFinite(m.width) && Number.isFinite(m.height) && m.width >= 640 && m.height >= 480,
  );
  if (!usable.length) return null;
  return usable.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
}

/** `Resolution: 3456 x 2234 Retina` — the spacing around `x` varies by version. */
export function parseMacPixels(stdout: string): ScreenPixels | null {
  const modes = [...stdout.matchAll(/Resolution:\s*(\d+)\s*x\s*(\d+)/gi)].map((m) => ({
    width: Number(m[1]),
    height: Number(m[2]),
  }));
  return largest(modes);
}

/** One `1920x1080` per adapter; blank lines for adapters with no active mode. */
export function parseWindowsPixels(stdout: string): ScreenPixels | null {
  const modes = [...stdout.matchAll(/(\d+)\s*x\s*(\d+)/g)].map((m) => ({
    width: Number(m[1]),
    height: Number(m[2]),
  }));
  return largest(modes);
}

/** xrandr marks the ACTIVE mode with `*`: `   1920x1080     60.00*+  59.94`. */
export function parseLinuxPixels(stdout: string): ScreenPixels | null {
  const active = [...stdout.matchAll(/^\s*(\d+)x(\d+)\s+[\d.\s]*\*/gm)].map((m) => ({
    width: Number(m[1]),
    height: Number(m[2]),
  }));
  if (active.length) return largest(active);
  // Fall back to the connected output's geometry: `HDMI-1 connected 1920x1080+0+0`.
  const connected = [...stdout.matchAll(/\bconnected\b[^\n]*?(\d+)x(\d+)\+\d+\+\d+/g)].map((m) => ({
    width: Number(m[1]),
    height: Number(m[2]),
  }));
  return largest(connected);
}
