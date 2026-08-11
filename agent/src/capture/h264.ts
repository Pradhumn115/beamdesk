import { Decoder, DeviceAPI, FilterAPI } from "node-av/api";
import { Codec, CodecContext, Dictionary, Packet, Rational, type Frame } from "node-av";
import { platform } from "node:os";
import {
  AV_PIX_FMT_YUV420P,
  AV_PIX_FMT_NV12,
  AV_PICTURE_TYPE_I,
  AV_PICTURE_TYPE_NONE,
  FF_ENCODER_LIBX264,
  FF_ENCODER_H264_VIDEOTOOLBOX,
  FF_ENCODER_H264_NVENC,
  FF_ENCODER_H264_QSV,
  FF_ENCODER_H264_AMF,
  FF_ENCODER_H264_VAAPI,
} from "node-av/constants";
import { FrameFormat } from "@bcsa/shared";
import type { FrameHandler, ScreenCapture } from "./index.js";

/**
 * Screen capture that emits H.264, entirely in-process.
 *
 * ## Why H.264 rather than Classic's MJPEG
 *
 * Every JPEG is intra-coded, so a completely static screen costs full price on
 * every frame: measured at ~267KB/frame on a 1920-wide desktop, which is
 * ~63 Mbit/s at 30fps and is why Classic only ever worked well on a LAN. H.264
 * sends only what changed — measured on a real desktop at ~7.4KB/frame,
 * roughly 1.8 Mbit/s. That ~35x reduction is what makes video usable over a
 * real network.
 *
 * ## Why there is no ffmpeg subprocess
 *
 * An ffmpeg child process cannot be reconfigured once started: no live bitrate
 * change, no resolution change, and above all no keyframe on demand (verified
 * — this ffmpeg build exposes no `zmq` filter, and neither `scale`, `fps` nor
 * libx264 accept runtime commands). A receiver that joins late or loses a
 * keyframe then renders nothing until the GOP rolls round, which is seconds of
 * blank screen.
 *
 * Driving libav in-process makes all three ordinary calls. It also removes an
 * entire class of failure this project kept hitting: no pipe carrying
 * undelimited rawvideo whose frame boundaries must be guessed, no `-pix_fmt`
 * that silently attaches to the input instead of the output, no stderr
 * scraping, and no wedged-but-alive child process to watch for.
 *
 * On macOS `DeviceAPI.openScreen()` additionally reaches ScreenCaptureKit,
 * Apple's current capture API, rather than the legacy avfoundation path that
 * logs "Configuration of video device failed, falling back to default".
 *
 * ## The low-level encoder API is deliberate
 *
 * This uses `CodecContext.sendFrame()` rather than node-av's ergonomic
 * `Encoder.packets()` wrapper, because that wrapper silently drops
 * `frame.pict_type` — verified by tagging a frame, reading the property back
 * as I, and observing no IDR in the output. Requested keyframes would simply
 * never appear, and since a receiver cannot decode anything before its first
 * keyframe, that surfaces as a permanently black screen. Do not "simplify"
 * this to the high-level API without re-verifying that forced keyframes still
 * come out.
 */
export interface H264CaptureOptions {
  /** Encoded output width; height follows the display's aspect ratio. */
  width?: number;
  fps?: number;
  bitrateKbps?: number;
  /**
   * Seconds between automatic IDRs. Only a recovery floor — a receiver that
   * needs one sooner asks, and requestKeyframe() answers immediately.
   */
  gopSeconds?: number;
  /**
   * Size to request FROM the capture device, when the display's own default is
   * not what you want.
   *
   * On a Retina Mac the device reports the logical size (1728 wide for a
   * 3456-pixel panel), and the encode width is clamped to it -- so native
   * detail was unreachable no matter how high the encode width was set.
   * Requesting an explicit size lifts that ceiling. Omit to let the device
   * choose, which is the historical behaviour.
   */
  captureWidth?: number;
  captureHeight?: number;
}

const DEFAULTS = { width: 1280, fps: 30, bitrateKbps: 2500, gopSeconds: 2 };

/**
 * An encoder to try, with the options it needs to behave for live streaming.
 *
 * Hardware encoders do not share libx264's vocabulary — there is no `preset`,
 * no `tune`, no `x264-params` — so each carries its own settings rather than a
 * shared bag with holes in it.
 */
interface EncoderCandidate {
  name: string;
  options: Record<string, string>;
}

/**
 * Software encoder. Always last, and always present: it is the only candidate
 * guaranteed to exist on every platform, so it is what makes the hardware
 * attempts safe to make at all.
 *
 * `forced-idr` is required for pict_type=I to produce a real IDR rather than an
 * open-GOP I-frame a receiver cannot start from. `sliced-threads=0` keeps one
 * slice per frame, since browser decoders handle multi-slice frames unreliably
 * and `tune=zerolatency` enables slicing by default.
 */
const SOFTWARE: EncoderCandidate = {
  name: FF_ENCODER_LIBX264,
  options: {
    preset: "ultrafast",
    tune: "zerolatency",
    "forced-idr": "1",
    "x264-params": "sliced-threads=0",
    threads: "1",
  },
};

/**
 * Hardware encoders worth trying before falling back to software, by platform.
 *
 * Measured on Apple silicon at 1728x1116: VideoToolbox 3.78ms/frame against
 * libx264's 4.72ms. Both are far faster than the 33ms budget at 30fps, so this
 * is about battery, thermals and headroom for higher resolutions rather than
 * about keeping up.
 *
 * Availability is not assumed anywhere: a candidate that fails to open is
 * simply skipped. A machine with no NVIDIA card, a locked-down VAAPI device, or
 * a node-av build without a given encoder all land on software without
 * anything to configure.
 */
function hardwareCandidates(): EncoderCandidate[] {
  switch (platform()) {
    case "darwin":
      // `realtime` keeps latency bounded; `prio_speed` biases the encoder
      // toward speed over compression, which suits screen content.
      return [{ name: FF_ENCODER_H264_VIDEOTOOLBOX, options: { realtime: "1", prio_speed: "1" } }];
    case "win32":
      return [
        { name: FF_ENCODER_H264_NVENC, options: { preset: "p1", tune: "ull", zerolatency: "1" } },
        { name: FF_ENCODER_H264_QSV, options: { preset: "veryfast", low_power: "1" } },
        { name: FF_ENCODER_H264_AMF, options: { usage: "ultralowlatency", quality: "speed" } },
      ];
    default:
      return [
        { name: FF_ENCODER_H264_NVENC, options: { preset: "p1", tune: "ull", zerolatency: "1" } },
        { name: FF_ENCODER_H264_VAAPI, options: {} },
      ];
  }
}

/**
 * Can this machine actually capture and encode H.264 in-process?
 *
 * Probed by doing it rather than by inspecting the platform: the screen device
 * may be missing or permission-denied, node-av's binary may lack an encoder,
 * and a hardware encoder may accept the codec but reject these options. All of
 * those are only answerable by trying, and all of them must degrade to the
 * older capture path rather than leaving a black screen.
 *
 * Deliberately opens and closes a real device and a real encoder. That costs a
 * few hundred milliseconds once at startup, which is the right price for
 * picking a video path that works.
 */
export async function h264CaptureAvailable(): Promise<boolean> {
  try {
    const demuxer = await DeviceAPI.openScreen({ frameRate: 30 });
    try {
      const stream = demuxer.video();
      if (!stream) return false;
      const codec = Codec.findEncoderByName(FF_ENCODER_LIBX264);
      if (!codec) return false;
      const ctx = new CodecContext();
      ctx.allocContext3(codec);
      ctx.width = 320;
      ctx.height = 240;
      ctx.pixelFormat = AV_PIX_FMT_YUV420P;
      ctx.timeBase = new Rational(1, 30);
      ctx.framerate = new Rational(30, 1);
      ctx.bitRate = 500_000n;
      return (await ctx.open2(codec, Dictionary.fromObject({ preset: "ultrafast" }))) >= 0;
    } finally {
      // Release the capture device immediately: two processes cannot capture
      // the screen at once, and holding it here would break the real capture
      // that is about to start.
      await (demuxer as { close?: () => Promise<void> }).close?.();
    }
  } catch {
    return false;
  }
}

export class H264Capture implements ScreenCapture {
  private handler: FrameHandler | null = null;
  private running = false;
  /** Bumped on every (re)start so a superseded pump loop exits. */
  private generation = 0;
  /** The in-flight pump, so a restart can wait for it to release the device. */
  private pumpDone: Promise<void> | null = null;
  private width: number;
  private fps: number;
  private bitrateKbps: number;
  private gopSeconds: number;
  private pts = 0n;
  /** Set by requestKeyframe(); consumed by the next frame encoded. */
  private forceKeyframe = false;
  /** Which encoder actually opened, so the choice is logged only when it changes. */
  private encoderName: string | null = null;
  /**
   * Rebuild the encoder on the next frame, keeping the capture device open.
   *
   * Bitrate is the lever the controller moves constantly, and it is purely an
   * encoder property -- the device and decoder are indifferent to it. Tearing
   * the whole session down for it meant reopening the screen grabber every
   * ~2s during a ramp, which re-probes the input (the "not enough frames to
   * estimate rate" spam), stalls capture and forces a keyframe. Industry
   * practice is to reconfigure the encoder in place and never touch the
   * capture source; this is the closest that libavcodec allows.
   */
  private encoderDirty = false;
  /** Rebuild the scaler AND encoder on the next frame, still keeping the device. */
  private geometryDirty = false;
  /** Explicit capture size to request from the device, when one is wanted. */
  private captureWidth: number | null = null;
  private captureHeight: number | null = null;

  constructor(opts: H264CaptureOptions = {}) {
    this.width = opts.width ?? DEFAULTS.width;
    this.fps = opts.fps ?? DEFAULTS.fps;
    this.bitrateKbps = opts.bitrateKbps ?? DEFAULTS.bitrateKbps;
    this.gopSeconds = opts.gopSeconds ?? DEFAULTS.gopSeconds;
    this.captureWidth = opts.captureWidth ?? null;
    this.captureHeight = opts.captureHeight ?? null;
  }

  start(handler: FrameHandler): void {
    this.handler = handler;
    this.running = true;
    this.restart();
  }

  /**
   * Cadence control, to satisfy the ScreenCapture interface. Interpreted as an
   * fps target; changing it restarts capture, since the device's frame rate and
   * the encoder's timebase are both fixed when they are opened.
   */
  setInterval(ms: number): void {
    const fps = Math.min(60, Math.max(1, Math.round(1000 / ms)));
    if (fps === this.fps) return;
    this.fps = fps;
    if (this.running) this.restart();
  }

  /**
   * Emit an IDR on the next frame.
   *
   * This is the capability that justifies an in-process encoder at all. A
   * receiver cannot decode anything until it has a keyframe, so on a fresh
   * connection or after loss it must be able to ask for one rather than wait
   * out the GOP.
   */
  requestKeyframe(): void {
    this.forceKeyframe = true;
  }

  /**
   * Re-open the encoder at a new bitrate, measured at ~2.2ms.
   *
   * Cheap enough to treat as continuous adaptation: the equivalent for a
   * subprocess was a ~300ms restart plus a capture-device reopen, which is why
   * adaptive quality was previously impractical here. The new encoder opens
   * with an IDR, so the receiver never sees a gap.
   */
  setBitrate(kbps: number): void {
    if (kbps === this.bitrateKbps || kbps <= 0) return;
    this.bitrateKbps = kbps;
    // Applied by the pump on its next frame -- no device reopen. See
    // encoderDirty.
    this.encoderDirty = true;
  }

  /**
   * Re-open at a smaller frame size and/or lower frame rate.
   *
   * The lever of last resort. Bitrate alone cannot rescue a link once it is at
   * the floor: below roughly 400kbps there are not enough bits to describe this
   * many pixels this often, and the picture turns to mush rather than degrading
   * gracefully. Spending the remaining budget on fewer pixels or fewer frames
   * is what keeps text legible on a bad link.
   *
   * Both move together because they trade against each other — halving the
   * frame rate frees roughly what halving the pixel count does — and the
   * controller decides the mix.
   */
  setScale(width: number, fps: number): void {
    const w = Math.max(320, Math.trunc(width / 2) * 2);
    const f = Math.min(60, Math.max(1, Math.round(fps)));
    if (w === this.width && f === this.fps) return;
    const fpsChanged = f !== this.fps;
    this.width = w;
    this.fps = f;
    if (!this.running) return;
    // Scaling happens in the filter graph, not the device, so a width change
    // needs only the scaler and encoder rebuilt. Frame rate is fixed when the
    // device is opened, so that alone still costs a full restart.
    if (fpsChanged) this.restart();
    else this.geometryDirty = true;
  }

  /**
   * The encoder that actually opened (h264_videotoolbox, libx264, ...).
   *
   * Reported rather than assumed: candidates are tried in order and the first
   * that opens wins, so nothing before runtime knows whether this machine ended
   * up on hardware or software.
   */
  get activeEncoder(): string | null {
    return this.encoderName;
  }

  /** Current encode width, so a controller can step relative to it. */
  get encodeWidth(): number {
    return this.width;
  }

  /** Current encode frame rate. */
  get encodeFps(): number {
    return this.fps;
  }

  stop(): void {
    this.running = false;
    this.handler = null;
    this.generation++;
  }

  /**
   * Opens the first encoder that works, hardware first.
   *
   * Tried in order rather than detected up front, because "is this encoder
   * usable" is not answerable without opening it: the binary may lack the
   * encoder, the machine may lack the device, a VAAPI node may be
   * permission-denied, or a driver may accept the codec and refuse these
   * particular options. Attempting and falling back turns all of those into the
   * same outcome — software — with nothing for the user to configure.
   *
   * BCSA_H264_ENCODER pins one by name, which is how the browser-decode tests
   * exercise a specific encoder rather than whatever this machine happens to
   * prefer.
   */
  private async openEncoder(width: number, height: number): Promise<CodecContext> {
    const pinned = process.env.BCSA_H264_ENCODER;
    const candidates = pinned
      ? [{ name: pinned, options: {} }, SOFTWARE].filter((c, i) => i === 0 || c.name !== pinned)
      : [...hardwareCandidates(), SOFTWARE];

    const failures: string[] = [];
    for (const candidate of candidates) {
      try {
        const ctx = await this.tryOpen(candidate, width, height);
        if (ctx) {
          if (candidate.name !== this.encoderName) {
            this.encoderName = candidate.name;
            process.stderr.write(`[h264] encoder: ${candidate.name} at ${width}x${height}\n`);
            // Falling back to software is a real performance cliff, and it used
            // to happen in total silence: `failures` was only reported when
            // EVERY candidate failed. A machine with a perfectly good GPU could
            // sit on libx264 forever with nothing to explain why.
            if (candidate.name === SOFTWARE.name && failures.length > 0) {
              process.stderr.write(
                `[h264] SOFTWARE fallback -- hardware encoders unavailable: ${failures.join("; ")}\n`,
              );
            }
          }
          return ctx;
        }
        failures.push(candidate.name);
      } catch (err) {
        failures.push(`${candidate.name} (${String(err)})`);
      }
    }
    throw new Error(`no usable H.264 encoder. Tried: ${failures.join(", ")}`);
  }

  private async tryOpen(
    candidate: EncoderCandidate,
    width: number,
    height: number,
  ): Promise<CodecContext | null> {
    const codec = Codec.findEncoderByName(candidate.name as never);
    if (!codec) return null;
    const ctx = new CodecContext();
    ctx.allocContext3(codec);
    ctx.width = width;
    ctx.height = height;
    ctx.pixelFormat = AV_PIX_FMT_YUV420P;
    ctx.timeBase = new Rational(1, this.fps);
    ctx.framerate = new Rational(this.fps, 1);
    ctx.gopSize = this.fps * this.gopSeconds;
    ctx.bitRate = BigInt(this.bitrateKbps * 1000);
    const ret = await ctx.open2(codec, Dictionary.fromObject(candidate.options));
    return ret < 0 ? null : ctx;
  }

  /**
   * Supersedes the running pump and starts a fresh one.
   *
   * The new session waits for the old one to finish tearing down rather than
   * opening alongside it. Two capture streams on the same display contend for
   * it, so overlapping even briefly on every adaptation step is what turned a
   * cheap restart into a frame-rate cliff.
   */
  private restart(): void {
    const generation = ++this.generation;
    const previous = this.pumpDone;
    this.pumpDone = (async () => {
      if (previous) await previous;
      // Another restart (or a stop) landed while the old session was closing.
      if (generation !== this.generation || !this.running) return;
      await this.pump(generation);
    })();
  }

  /**
   * Runs one capture -> scale -> encode session until superseded or stopped.
   *
   * Guarded by `generation` rather than a boolean so a restart (fps or bitrate
   * change) cleanly abandons the previous loop: the old iteration sees a stale
   * generation on its next frame and returns, leaving exactly one pump running.
   */
  private async pump(generation: number): Promise<void> {
    let demuxer: Awaited<ReturnType<typeof DeviceAPI.openScreen>> | null = null;
    let decoder: Decoder | null = null;
    let filter: FilterAPI | null = null;
    let ctx: CodecContext | null = null;
    try {
      demuxer = await DeviceAPI.openScreen({
        frameRate: this.fps,
        // Ask for the size we actually want to encode.
        //
        // Without this the device hands back the display's LOGICAL size (1728
        // wide on a Retina Mac whose panel is 3456), and `min(this.width,
        // srcW)` below then clamps everything to it -- so a higher
        // BCSA_MAX_WIDTH silently did nothing and the stream could never carry
        // native detail. Omitted when no explicit width is wanted, so the
        // device keeps choosing.
        ...(this.captureWidth && this.captureHeight
          ? { width: this.captureWidth, height: this.captureHeight }
          : {}),
        // Ask for what the device actually produces. ScreenCaptureKit offers
        // only nv12 and bgr0, so requesting yuv420p here made avfoundation
        // override the choice on every open; the filter graph below converts
        // to yuv420p anyway, which is where the conversion belongs.
        pixelFormat: AV_PIX_FMT_NV12,
        // Probe long enough to estimate the input frame rate. The default
        // budget sees only a frame or two from a screen device that emits on
        // change, so the rate came back unknown on every single open.
        formatOptions: { probesize: 5_000_000, analyzeduration: 2_000_000 },
      });
      const stream = demuxer.video();
      if (!stream) throw new Error("screen device exposed no video stream");

      const srcW = stream.codecpar.width;
      const srcH = stream.codecpar.height;
      // Even dimensions are mandatory: yuv420p subsamples chroma 2x2, so an odd
      // width or height is rejected by the encoder outright. Odd source sizes
      // are ordinary — fractional DPI scaling yields sizes like 1707x1067.
      const w = Math.trunc(Math.min(this.width, srcW) / 2) * 2;
      const h = Math.trunc((srcH * w) / srcW / 2) * 2;

      decoder = await Decoder.create(stream);
      // The filter graph does scaling and pixel-format conversion in one pass:
      // the screen device delivers nv12 (ScreenCaptureKit) or a packed RGB
      // variant depending on platform, and libx264 needs planar yuv420p.
      filter = FilterAPI.create(`scale=${w}:${h},format=yuv420p`);
      ctx = await this.openEncoder(w, h);
      this.pts = 0n;
      // A new encoder's first frame must be an IDR, or the receiver has
      // nothing to start decoding from.
      this.forceKeyframe = true;

      let w2 = w;
      let h2 = h;
      for await (const frame of decoder.frames(demuxer.packets(stream.index))) {
        if (generation !== this.generation || !this.running) break;
        if (!frame) continue;

        // Apply pending quality changes WITHOUT reopening the device.
        if (this.geometryDirty || this.encoderDirty) {
          const wantGeometry = this.geometryDirty;
          this.geometryDirty = false;
          this.encoderDirty = false;
          if (wantGeometry) {
            w2 = Math.trunc(Math.min(this.width, srcW) / 2) * 2;
            h2 = Math.trunc((srcH * w2) / srcW / 2) * 2;
            filter.close();
            filter = FilterAPI.create(`scale=${w2}:${h2},format=yuv420p`);
          }
          // A live bit_rate write is what NVENC's (unmerged) reconfigure path
          // would honour; libavcodec generally reads rate control only at open,
          // so unless BCSA_LIVE_BITRATE says otherwise the encoder is rebuilt.
          if (!wantGeometry && this.tryLiveBitrate(ctx)) {
            // Reconfigured in place: no new encoder, no keyframe needed.
          } else {
            ctx.freeContext();
            ctx = await this.openEncoder(w2, h2);
            // A fresh encoder's first frame must be an IDR or the receiver has
            // nothing to decode from.
            this.forceKeyframe = true;
          }
        }

        await filter.process(frame);
        const scaled = await filter.receive();
        frame.free?.();
        if (!scaled) continue;
        await this.encodeOne(ctx, scaled);
        scaled.free?.();
      }
    } catch (err) {
      if (generation === this.generation && this.running) {
        process.stderr.write(`[h264] capture failed: ${String(err)}\n`);
      }
    } finally {
      // Released in reverse order of acquisition, and unconditionally.
      //
      // Without this, every bitrate change leaked a live capture session: the
      // superseded loop saw a stale generation and broke out of the frame
      // iteration, but the device it opened kept streaming. With the adaptive
      // controller stepping bitrate roughly every 2s, sessions accumulated
      // until several ScreenCaptureKit streams were capturing the same display
      // at once, contending for it — which is what dragged an intended 30fps
      // down to single digits.
      ctx?.freeContext();
      filter?.close();
      decoder?.close();
      await demuxer?.close();
    }
  }

  /**
   * Attempt an in-place bitrate change, as NVENC's reconfigure path allows.
   *
   * Off by default and deliberately so: node-av exposes a writable `bitRate`
   * mapping straight to AVCodecContext->bit_rate, but libavcodec reads rate
   * control at open time for every encoder in this build, so the write would
   * be accepted and silently ignored -- leaving the controller convinced it
   * had lowered bitrate while nothing changed. Enabled with
   * BCSA_LIVE_BITRATE=1 for measuring whether a given encoder honours it.
   */
  private tryLiveBitrate(ctx: CodecContext): boolean {
    if (process.env.BCSA_LIVE_BITRATE !== "1") return false;
    try {
      ctx.bitRate = BigInt(this.bitrateKbps * 1000);
      return true;
    } catch {
      return false;
    }
  }

  private async encodeOne(ctx: CodecContext, frame: Frame): Promise<void> {
    const handler = this.handler;
    if (!handler) return;
    frame.pts = this.pts++;
    frame.pictType = this.forceKeyframe ? AV_PICTURE_TYPE_I : AV_PICTURE_TYPE_NONE;
    this.forceKeyframe = false;

    await ctx.sendFrame(frame);
    for (;;) {
      const pkt = new Packet();
      pkt.alloc();
      const ret = await ctx.receivePacket(pkt);
      if (ret < 0) {
        pkt.free?.();
        break;
      }
      const bytes = pkt.data;
      if (bytes && bytes.length) {
        handler({
          data: new Uint8Array(bytes),
          format: FrameFormat.H264,
          keyframe: pkt.isKeyframe ?? false,
        });
      }
      pkt.free?.();
    }
  }
}
