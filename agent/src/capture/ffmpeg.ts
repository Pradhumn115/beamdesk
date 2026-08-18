import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { FrameFormat } from "@bcsa/shared";
import type { CapturedImage, FrameHandler, ScreenCapture } from "./index.js";

export interface FfmpegCaptureOptions {
  /** Max output width in pixels; height auto to keep aspect. Default 1920. */
  maxWidth?: number;
  /** MJPEG quality 2 (best) .. 31 (worst). Default 6. */
  quality?: number;
}

/** True if an `ffmpeg` binary is on PATH. */
export function ffmpegAvailable(): boolean {
  try {
    return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Continuous screen capture via ffmpeg, emitting a stream of JPEG frames. Unlike
 * the per-frame screenshot approach (which spawns a process each grab and caps
 * at a few fps), ffmpeg keeps one capture session open and can sustain ~30fps.
 *
 * setInterval(ms) maps to a target framerate (fps = 1000/ms, clamped 1..60).
 * Changing it restarts ffmpeg with the new rate.
 */
export class FfmpegCapture implements ScreenCapture {
  private proc: ChildProcess | null = null;
  private handler: FrameHandler | null = null;
  private fps = 15;
  private running = false;
  private buf: Buffer = Buffer.alloc(0);
  private readonly maxWidth: number;
  private readonly quality: number;

  constructor(opts: FfmpegCaptureOptions = {}) {
    this.maxWidth = opts.maxWidth ?? 1920;
    this.quality = opts.quality ?? 6;
  }

  start(handler: FrameHandler): void {
    this.handler = handler;
    this.running = true;
    this.spawnFfmpeg();
  }

  setInterval(ms: number): void {
    // Cap at 120fps; the real ceiling is the display refresh rate (e.g. 60Hz,
    // or 120Hz on ProMotion) and available bandwidth.
    const fps = Math.min(120, Math.max(1, Math.round(1000 / ms)));
    if (fps === this.fps) return;
    this.fps = fps;
    if (this.running) this.spawnFfmpeg(); // restart at the new rate
  }

  stop(): void {
    this.running = false;
    this.handler = null;
    this.killProc();
    this.buf = Buffer.alloc(0);
  }

  private killProc(): void {
    if (this.proc) {
      this.proc.kill("SIGKILL");
      this.proc = null;
    }
  }

  private spawnFfmpeg(): void {
    this.killProc();
    this.buf = Buffer.alloc(0);

    const args = this.buildArgs();
    // stderr is piped rather than ignored: at -loglevel error ffmpeg only
    // speaks up when something is actually wrong, and discarding it made
    // capture failures indistinguishable from "no frames yet" — the client
    // just showed NO SIGNAL forever with nothing explaining why. Windows
    // gdigrab in particular dies with "Failed to capture image (error 5)"
    // whenever a secure desktop (UAC prompt, lock screen, Ctrl+Alt+Del)
    // takes over, which is otherwise completely silent.
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;

    proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    let linePartial = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      const lines = (linePartial + chunk).split("\n");
      linePartial = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) process.stderr.write(`[capture] ffmpeg: ${line}\n`);
      }
    });
    proc.on("error", (err) => {
      process.stderr.write(`[ffmpeg] spawn error: ${String(err)}\n`);
    });
    proc.on("exit", (code) => {
      // If we're still meant to be running, a non-null exit means it crashed;
      // don't hot-loop — the next setInterval/start will respawn.
      if (this.running && this.proc === proc) this.proc = null;
      if (this.running && code !== null && code !== 0) {
        process.stderr.write(`[ffmpeg] exited with code ${code}\n`);
      }
    });
  }

  private buildArgs(): string[] {
    const common = [
      "-loglevel", "error",
      // fps filter caps the OUTPUT rate: screen-capture inputs (esp. macOS
      // avfoundation) ignore the input -framerate and would otherwise emit
      // frames as fast as possible. scale keeps width <= maxWidth (even height).
      "-vf", `${captureFilterPrefix()}fps=${this.fps},scale='min(${this.maxWidth},iw)':-2`,
      "-c:v", "mjpeg",
      "-q:v", String(this.quality),
      "-f", "mjpeg",
      "pipe:1",
    ];
    return [...screenCaptureInputArgs(this.fps), ...common];
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // Extract every complete JPEG in the buffer. We walk the JPEG marker
    // structure (respecting segment lengths) rather than scanning for raw
    // FFD8/FFD9 bytes, because those byte pairs legitimately occur inside
    // header tables (DQT/DHT) and would otherwise split a frame incorrectly.
    for (;;) {
      const soi = findSoi(this.buf);
      if (soi < 0) return;
      if (soi > 0) this.buf = this.buf.subarray(soi); // drop leading junk
      const end = jpegEnd(this.buf);
      if (end < 0) return; // incomplete; wait for more data
      const jpeg = this.buf.subarray(0, end);
      this.buf = this.buf.subarray(end);
      if (this.handler) {
        const image: CapturedImage = { data: new Uint8Array(jpeg), format: FrameFormat.JPEG };
        this.handler(image);
      }
    }
  }
}

/** Index of the next JPEG SOI (FF D8), or -1. */
function findSoi(buf: Buffer): number {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8) return i;
  }
  return -1;
}

/**
 * Given a buffer whose start is a JPEG SOI, return the index just past the EOI
 * of that single JPEG, or -1 if the buffer doesn't yet contain the whole frame.
 * Walks marker segments and skips entropy-coded scan data (handling byte
 * stuffing and restart markers), so it never mistakes table bytes for markers.
 */
function jpegEnd(buf: Buffer): number {
  let i = 2; // past SOI (FF D8)
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd9) return i + 2; // EOI
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2; // standalone marker (RSTn / TEM), no length
      continue;
    }
    if (i + 3 >= buf.length) return -1; // need the 2-byte length
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (marker === 0xda) {
      // SOS: skip its header, then scan entropy data for the next real marker.
      let j = i + 2 + len;
      while (j < buf.length - 1) {
        if (buf[j] === 0xff) {
          const m = buf[j + 1];
          if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
            j += 2; // stuffed FF or restart marker: part of scan data
            continue;
          }
          break; // real marker (e.g. EOI) begins here
        }
        j++;
      }
      if (j >= buf.length - 1) return -1;
      i = j;
      continue;
    }
    i += 2 + len; // skip this segment
  }
  return -1;
}

/**
 * Which Windows screen-capture backend to use.
 *
 * `gdigrab` (default) is the universally-compatible GDI path, but it has a
 * hard limitation: it exits with "Failed to capture image (error 5)"
 * (ERROR_ACCESS_DENIED) whenever a secure desktop takes over — a UAC prompt,
 * the lock screen, Ctrl+Alt+Del — and cannot recover in-process.
 *
 * `ddagrab` uses the Desktop Duplication API (DXGI): it reads from the GPU,
 * handles fullscreen-exclusive windows that GDI cannot capture, and is the
 * modern recommended path. It needs Windows 8+, a 64-bit ffmpeg, and a build
 * with the filter compiled in, which is why it is opt-in rather than the
 * default — a machine where gdigrab works today must not lose video to an
 * unavailable filter.
 *
 * Opt in with `BCSA_WIN_CAPTURE=ddagrab` before starting the agent.
 */
export type WinCaptureBackend = "gdigrab" | "ddagrab";

export function winCaptureBackend(): WinCaptureBackend {
  return process.env.BCSA_WIN_CAPTURE === "ddagrab" ? "ddagrab" : "gdigrab";
}

/**
 * Filter-chain prefix required by the active capture backend, or "" when none
 * is needed. ddagrab exclusively emits D3D11 *hardware* frames, so anything
 * downstream that runs on the CPU (our fps/scale/crop filters, libx264,
 * mjpeg) must be preceded by an explicit hwdownload back to system memory.
 * Omitting it makes ffmpeg fail with a format-negotiation error rather than
 * silently misbehave.
 */
export function captureFilterPrefix(): string {
  return platform() === "win32" && winCaptureBackend() === "ddagrab"
    ? "hwdownload,format=bgra,"
    : "";
}

/**
 * Per-OS screen-capture input args (`-f <format> ... -i <device>`), shared by
 * FfmpegCapture's MJPEG-over-pipe pipeline — the H.264 path captures
 * in-process instead (see capture/h264.ts) and does not use this.
 */
export function screenCaptureInputArgs(fps: number): string[] {
  // Synthetic source for automated tests (BCSA_FAKE_CAPTURE=1).
  //
  // Grabbing the real screen needs an OS capture permission that is granted to
  // a *responsible process*, and that grant does not follow an arbitrary
  // process tree: an agent spawned by a test runner gets no frames at all even
  // though the same agent started from a shell works fine. Headless CI has no
  // display to grab in the first place. Either way the encoder produces
  // nothing and every downstream assertion fails for a reason that has nothing
  // to do with the code under test.
  //
  // The end-to-end tests exercise the transport and codec path — negotiation,
  // profile, level, packetisation, whether a browser can decode it — none of
  // which cares where the pixels came from. A deterministic pattern makes that
  // path testable anywhere, and keeps a genuine failure distinguishable from a
  // missing permission.
  if (process.env.BCSA_FAKE_CAPTURE) {
    // Deliberately not 16:9: the level-conformance maths is area-based, and a
    // 16:9 source is the one shape a naive width cap also gets right, so
    // testing with it would hide exactly the bug that shipped.
    // -re paces the source at wall-clock rate. Without it lavfi generates
    // frames as fast as the CPU allows and the encoder emits hundreds of fps,
    // so a test would neither reflect real timing nor catch a stall.
    return ["-re", "-f", "lavfi", "-i", `testsrc=size=1512x982:rate=${fps}`];
  }
  switch (platform()) {
    case "darwin":
      return [
        "-f", "avfoundation",
        "-capture_cursor", "1",
        // Ask for what the device actually offers.
        //
        // ffmpeg's avfoundation demuxer defaults its `pixel_format` to
        // yuv420p, and a ScreenCaptureKit display offers only uyvy422,
        // yuyv422, nv12, 0rgb and bgr0 -- so it refused to open at all:
        // "Selected pixel format (yuv420p) is not supported by the input
        // device". That killed the MJPEG path outright on any Mac using
        // ScreenCaptureKit; the fallback spawned, emitted no frames, and the
        // viewer got a permanently blank stream. The filter chain and the
        // mjpeg encoder convert from here, so nothing downstream cares.
        // See H264Capture, which requests nv12 for the same reason.
        "-pixel_format", "nv12",
        "-framerate", String(fps),
        "-i", `${macScreenDevice()}:none`,
      ];
    case "win32":
      return winCaptureBackend() === "ddagrab"
        ? // ddagrab is a lavfi *source filter*, not a demuxer, so it's given
          // as `-f lavfi -i ddagrab=...` rather than `-f ddagrab`.
          ["-f", "lavfi", "-i", `ddagrab=output_idx=0:framerate=${fps}`]
        : [
            "-f", "gdigrab",
            "-framerate", String(fps),
            // gdigrab hands ffmpeg raw BGRA frames (~8MB at 1080p). The
            // default probesize (5MB) can't hold even one full frame, so
            // avformat_find_stream_info logs "not enough frames to estimate
            // rate; consider increasing probesize" on every spawn even
            // though -framerate above already tells ffmpeg the rate. A
            // larger probesize lets it see full frames and drops the warning.
            "-probesize", "42M",
            "-i", "desktop",
          ];
    default:
      return [
        "-f", "x11grab",
        "-framerate", String(fps),
        "-i", process.env.DISPLAY || ":0.0",
      ];
  }
}

let cachedMacDevice: string | null = null;
/**
 * The avfoundation device index for "Capture screen 0" varies per machine, so
 * detect it once by parsing ffmpeg's device list. Falls back to "1".
 */
function macScreenDevice(): string {
  if (cachedMacDevice !== null) return cachedMacDevice;
  try {
    const res = spawnSync("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      encoding: "utf8",
    });
    const text = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    const m = text.match(/\[(\d+)\]\s+Capture screen 0/i);
    // Only a SUCCESSFUL probe is cached.
    //
    // The fallback used to be cached too, and the enumeration is not reliably
    // available at startup — a display still being released by a previous
    // capture drops out of the list for a few seconds. One unlucky probe
    // therefore pinned device "1" (a camera, on most Macs) for the entire
    // session: ffmpeg opened happily, the log stayed clean, and the viewer got
    // a stream that never produced a single frame. Retrying costs one spawn on
    // a path that has already failed, and the next attempt usually succeeds.
    if (m) {
      cachedMacDevice = m[1];
      return cachedMacDevice;
    }
    process.stderr.write(
      "[capture] avfoundation did not list a screen device; retrying on the next spawn\n",
    );
  } catch (err) {
    process.stderr.write(`[capture] could not enumerate avfoundation devices: ${String(err)}\n`);
  }
  return "1";
}
