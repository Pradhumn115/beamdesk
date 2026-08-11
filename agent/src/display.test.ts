import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLinuxPixels, parseMacPixels, parseWindowsPixels } from "./display.js";

/**
 * These parsers decide the stream's maximum detail, so a silent parse failure
 * costs half the display's resolution — the exact bug they exist to fix. Real
 * command output, not hand-tidied samples.
 */

test("macOS: reads the Retina panel's true pixel size", () => {
  const out = `Graphics/Displays:

    Apple M4 Max:

      Chipset Model: Apple M4 Max
      Displays:
        Color LCD:
          Display Type: Built-in Liquid Retina XDR Display
          Resolution: 3456 x 2234 Retina
          Main Display: Yes`;
  assert.deepEqual(parseMacPixels(out), { width: 3456, height: 2234 });
});

test("macOS: picks the largest across multiple displays", () => {
  const out = `
          Resolution: 1920 x 1080
          Resolution: 3456 x 2234 Retina
          Resolution: 1280 x 720`;
  assert.deepEqual(parseMacPixels(out), { width: 3456, height: 2234 });
});

test("macOS: no resolution line yields null rather than a guess", () => {
  assert.equal(parseMacPixels("Graphics/Displays:\n\n    Apple M4 Max:\n"), null);
  assert.equal(parseMacPixels(""), null);
});

test("Windows: reads CurrentHorizontal/VerticalResolution output", () => {
  assert.deepEqual(parseWindowsPixels("1920x1080\r\n"), { width: 1920, height: 1080 });
});

test("Windows: ignores adapters with no active mode", () => {
  // A headless/virtual adapter reports 0x0; the real panel must still win.
  assert.deepEqual(parseWindowsPixels("0x0\r\n2560x1440\r\n"), { width: 2560, height: 1440 });
});

test("Linux: takes the mode xrandr marks active with *", () => {
  const out = `Screen 0: minimum 320 x 200, current 1920 x 1080, maximum 16384 x 16384
HDMI-1 connected primary 1920x1080+0+0 (normal left inverted right x axis y axis) 598mm x 336mm
   3840x2160     30.00    29.97
   1920x1080     60.00*+  59.94    50.00
   1280x720      60.00    59.94`;
  assert.deepEqual(parseLinuxPixels(out), { width: 1920, height: 1080 });
});

test("Linux: falls back to the connected output's geometry", () => {
  const out = `Screen 0: minimum 320 x 200, current 2560 x 1440, maximum 16384 x 16384
DP-2 connected primary 2560x1440+0+0 (normal left inverted right x axis y axis)`;
  assert.deepEqual(parseLinuxPixels(out), { width: 2560, height: 1440 });
});

test("Linux: a disconnected output contributes nothing", () => {
  assert.equal(parseLinuxPixels("HDMI-2 disconnected (normal left inverted right)"), null);
});

test("implausibly small modes are rejected on every platform", () => {
  // Guards against matching stray "8 x 6" style text in unrelated output.
  assert.equal(parseMacPixels("Resolution: 8 x 6"), null);
  assert.equal(parseWindowsPixels("16x16"), null);
});
