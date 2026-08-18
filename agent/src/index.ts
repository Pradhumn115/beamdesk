import { loadConfig } from "./config.js";
import { loadOrCreateTls } from "./tls.js";
import { formatConnectionLines, localAddresses } from "./net.js";
import { isElevated } from "./inputlock/elevation.js";
import { CaptureLoop, createScreenshotCapture, type ScreenCapture } from "./capture/index.js";
import { FfmpegCapture, ffmpegAvailable, screenCaptureInputArgs } from "./capture/ffmpeg.js";
import { detectRefreshHz, detectScreenPixels } from "./display.js";
import { InputController } from "./input/index.js";
import { createNutBackend } from "./input/nutBackend.js";
import { createNutTypingBackend } from "./autotyper/nutTyping.js";
import { createWindowsTypingBackend } from "./autotyper/winTyping.js";
import { ConnectionServer } from "./connection/index.js";
import { H264Capture, h264CaptureAvailable } from "./capture/h264.js";
import { WebtransportServer } from "./webtransport/server.js";
import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { AudioCapture, detectLoopbackDevice } from "./audio/index.js";
import { detectVolumeController } from "./audio/volume.js";
import { InputLockManager } from "./inputlock/index.js";
import { createInputLockBackend } from "./inputlock/backends.js";
import { registerLockHotkey } from "./inputlock/hotkey.js";
import { createNutClipboardBackend } from "./clipboard/index.js";

// Auto-release the input lock after this long without client activity.
const INPUT_LOCK_AUTO_RELEASE_MS = 10_000;

/**
 * Absolute path to the built client, or null when it has not been built.
 *
 * Checked at both the source and compiled layouts because the agent runs
 * either way: `tsx src/index.ts` in development and `node dist/index.js` after
 * a build, and the client sits at a different depth from each.
 */
function clientDistDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolvePath(here, "..", "..", "client", "dist"),
    resolvePath(here, "..", "..", "..", "client", "dist"),
  ]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const tls = loadOrCreateTls();

  // Windows first: nut-js resolves each character through VkKeyScan() there and
  // presses whatever modifiers that lookup reports, so AltGr punctuation
  // ({}[]\\|@~ on most non-US layouts) arrives as Ctrl+Alt and a character the
  // layout lacks arrives as Shift+Ctrl+Alt with an arbitrary virtual key -- in
  // a browser, Ctrl+T. The helper types via KEYEVENTF_UNICODE instead, which
  // consults no layout and presses no modifier. See autotyper/winTyping.ts.
  const windowsTyper = await createWindowsTypingBackend();
  if (process.platform === "win32" && !windowsTyper) {
    process.stderr.write(
      "[autotype] falling back to nut-js typing on Windows; " +
        "characters outside the active keyboard layout may trigger shortcuts\n",
    );
  }
  const typingBackend = windowsTyper ?? (await createNutTypingBackend());

  // Remote keystrokes take the same character path, so they get the same
  // protection.
  const input = new InputController(
    await createNutBackend({ typeChar: windowsTyper?.typeChar.bind(windowsTyper) }),
    {
      onStaleRelease: (count) =>
        process.stderr.write(
          `[input] released ${count} key(s) held with no matching key-up\n`,
        ),
    },
  );
  const clipboard = await createNutClipboardBackend();
  // Detect the loopback device once and share it between AudioCapture (Classic
  // audio) — detectLoopbackDevice() spawns
  // ffmpeg synchronously to enumerate devices, so running it twice at startup
  // is wasted work.
  const loopback = detectLoopbackDevice();
  const audio = new AudioCapture(loopback);
  // Controls the machine's own speakers, which is unrelated to capturing them:
  // a machine with no loopback device can still have its volume changed.
  const volume = await detectVolumeController();

  // Prefer the continuous ffmpeg pipeline (can sustain ~30fps); fall back to the
  // per-frame screenshot loop (a few fps) when ffmpeg isn't installed.
  // Encode width defaults to the agent's actual screen width rather than a
  // fixed 1920: quality is bits per pixel, and both the bitrate ceiling and
  // the quality ladder in connection/index.ts now scale with whatever this
  // ends up being (see BITRATE_MAX_KBPS_AT_1920 and buildQualityLadder there),
  // so a good link on a high-resolution display gets a correspondingly higher
  // ceiling instead of spreading a fixed budget over more pixels than it was
  // tuned for. Falls back to 1920 if screen size can't be read. BCSA_MAX_WIDTH
  // still overrides either way, e.g. to deliberately cap a weak link.
  // The PHYSICAL panel size, when it can be detected, in preference to the
  // logical one. screenSize() reports points, which on a Retina display is
  // half the real resolution — and since the capture device reports the same
  // logical size and the encode width is clamped to it, the stream could never
  // carry the display's actual detail. Falls back to points, then to 1920.
  const pixels = detectScreenPixels();
  const logicalWidth = await input
    .screenSize()
    .then((s) => s.width)
    .catch(() => 1920);
  const nativeWidth = pixels?.width ?? logicalWidth;
  const maxWidth = process.env.BCSA_MAX_WIDTH ? Number(process.env.BCSA_MAX_WIDTH) : nativeWidth;
  const refreshHz = detectRefreshHz();
  let capture: ScreenCapture;
  let captureKind: string;
  // H.264 is the default video path, with the older MJPEG paths as fallbacks.
  //
  // Same transport and same frame envelope as Classic — only the codec differs.
  // Measured on a real desktop: ~7.4KB/frame (~1.8 Mbit/s) against MJPEG's
  // ~267KB/frame (~63 Mbit/s), because H.264 sends only what changed while
  // every JPEG is intra-coded. It also captures via ScreenCaptureKit on macOS
  // rather than the legacy avfoundation route, which has been observed failing
  // outright ("Selected pixel format is not supported by the input device",
  // respawning without ever producing a frame) on machines where the in-process
  // path works fine.
  //
  // Availability is probed rather than assumed, because a missing screen
  // permission, a node-av build without an encoder, or a hardware encoder that
  // rejects these options are all only answerable by trying — and each must
  // degrade to a working path instead of a black screen.
  //
  // BCSA_H264=0 forces the old path, for comparing the two.
  const h264Wanted = process.env.BCSA_H264 !== "0";
  if (h264Wanted && (await h264CaptureAvailable())) {
    // BCSA_CAPTURE_WIDTH/HEIGHT ask the device for a specific size. Needed on
    // Retina displays, where the device otherwise reports logical points and
    // caps the encode width far below the panel's real resolution.
    const captureWidth = process.env.BCSA_CAPTURE_WIDTH
      ? Number(process.env.BCSA_CAPTURE_WIDTH)
      : pixels?.width;
    const captureHeight = process.env.BCSA_CAPTURE_HEIGHT
      ? Number(process.env.BCSA_CAPTURE_HEIGHT)
      : pixels?.height;
    capture = new H264Capture({
      width: maxWidth,
      fps: Math.min(60, refreshHz),
      captureWidth,
      captureHeight,
    });
    captureKind = `h264 in-process (max width ${maxWidth}px)`;
  } else if (ffmpegAvailable()) {
    capture = new FfmpegCapture({ maxWidth });
    captureKind = `ffmpeg MJPEG (targets display refresh ~${refreshHz}fps, max width ${maxWidth}px)`;
  } else {
    capture = new CaptureLoop(createScreenshotCapture());
    captureKind = "screenshot-desktop (install ffmpeg for higher fps)";
  }


  // `server` is referenced by the lock manager's onChange (declared before it
  // exists), so use a holder the arrow can read once it's assigned.
  let server: ConnectionServer;
  const inputLock = new InputLockManager({
    backend: createInputLockBackend(),
    autoReleaseMs: INPUT_LOCK_AUTO_RELEASE_MS,
    onChange: (locked) => server?.notifyLockState(locked),
  });

  // QUIC/WebTransport video listener, on the control port + 1.
  //
  // Optional by design: if it cannot start — no UDP path, port taken, native
  // module missing — video simply stays on the WebSocket, which is also the
  // only path that works for a browser without WebTransport or over a
  // Cloudflare Tunnel. A failure here must never stop the agent.
  let webtransport: WebtransportServer | null = new WebtransportServer({
    port: config.port + 1,
  });
  try {
    await webtransport.start();
  } catch (err) {
    process.stderr.write(`[webtransport] unavailable, video stays on WebSocket: ${String(err)}\n`);
    webtransport = null;
  }

  server = new ConnectionServer({
    secret: config.secret,
    nickname: config.nickname,
    port: config.port,
    tls: { cert: tls.cert, key: tls.key },
    input,
    capture,
    typingBackend,
    inputLock,
    audio,
    volume,
    clipboard,
    refreshHz,
    captureKind,
    // Serve the built client from the agent when it exists, so the UI is
    // reachable wherever the agent is — and, more importantly, from the SAME
    // origin as the WebSocket, which means accepting the certificate once
    // covers both. Absent in a source checkout that has not been built, where
    // the Vite dev server serves the UI instead.
    clientDir: clientDistDir(),
    initialBitrateKbps: 2500,
    webtransport: webtransport
      ? {
          port: webtransport.port,
          certHash: webtransport.certHash,
          get hasSession() {
            return webtransport!.hasSession;
          },
          get backlogBytes() {
            return webtransport!.backlogBytes;
          },
          send: (payload) => webtransport!.send(payload),
        }
      : undefined,
  });

  await server.listen();
  printBanner(config.port, config.secret, tls.fingerprint, captureKind, isElevated());

  // Optional agent-side toggle hotkey (Ctrl+Alt+L); no-ops if unavailable.
  const hotkey = await registerLockHotkey(() => void inputLock.toggle(), {
    // Never let the agent's own keystrokes toggle the lock out from under a run.
    suppressed: () => server.isAutotyping,
  });

  const shutdown = async (): Promise<void> => {
    process.stdout.write("\nShutting down…\n");
    hotkey.stop();
    await webtransport?.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

function printBanner(
  port: number,
  secret: string,
  fingerprint: string,
  captureKind: string,
  elevated: boolean,
): void {
  const addresses = localAddresses();
  const lines: string[] = [];
  lines.push("");
  lines.push("  Beamdesk — agent is running");
  lines.push("  ─────────────────────────────────");
  lines.push(`  Port:        ${port}`);
  lines.push(`  Secret:      ${secret}`);
  lines.push(`  Cert SHA-256:${fingerprint}`);
  lines.push(`  Capture:     ${captureKind}`);
  lines.push("");
  lines.push("  Connect from the client using one of:");
  lines.push(...formatConnectionLines(addresses, port));
  // isElevated() only reports false on a non-elevated Windows agent, where
  // BlockInput would be silently refused. Warn so the user isn't surprised when
  // "Lock agent's local input" fails.
  if (!elevated) {
    lines.push("");
    lines.push("  ⚠ Not running as Administrator — 'Lock agent's local input'");
    lines.push("    will be refused by Windows. Restart this agent from a terminal");
    lines.push("    opened with 'Run as administrator' to enable it.");
  }
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${String(err)}\n`);
  process.exit(1);
});
