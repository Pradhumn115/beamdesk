import { createServer, type Server as HttpsServer } from "node:https";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve as resolvePath, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AudioFormat,
  encodeAudioFrame,
  encodeFrame,
  encodeMessage,
  parseClientMessage,
  type AgentMessage,
  type AutotypeProfile,
} from "@bcsa/shared";
import type { ScreenCapture } from "../capture/index.js";
import type { AudioCapture } from "../audio/index.js";
import type { VolumeController } from "../audio/volume.js";
import { CoalescingApplier } from "../audio/coalesce.js";
import type { InputController } from "../input/index.js";
import { runAutotype, type TypingBackend } from "../autotyper/index.js";
import type { InputLockManager } from "../inputlock/index.js";
import { runDiagnostics } from "../diagnostics/index.js";
import { TrendlineEstimator } from "./trendline.js";
import { AckedRateTracker } from "./ackedrate.js";
import { StuckBacklogDetector } from "./stuckbacklog.js";
import { FramePacer } from "./pacer.js";
import type { ClipboardBackend } from "../clipboard/index.js";

export interface ServerDeps {
  secret: string;
  nickname: string;
  port: number;
  /** Interface to bind to; default binds all interfaces. */
  host?: string;
  tls: { cert: string; key: string };
  input: InputController;
  capture: ScreenCapture;
  typingBackend: TypingBackend;
  inputLock: InputLockManager;
  audio: AudioCapture;
  /** Controls the agent machine's own output volume; may report unsupported. */
  volume: VolumeController;
  /** Reads/writes the agent machine's system clipboard (text-only). */
  clipboard: ClipboardBackend;
  /** Detected display refresh rate (Hz), reported to the client for fps target. */
  refreshHz: number;
  /** Human-readable capture engine actually in use, surfaced in diagnostics. */
  captureKind?: string;
  /**
   * Absolute path to the built client, served over the same HTTPS origin as the
   * WebSocket. Omit to serve only the reachability page.
   */
  clientDir?: string;
  /** Starting point for the adaptive bitrate controller, in kbit/s. */
  initialBitrateKbps?: number;
  /**
   * QUIC/WebTransport video listener, when one started. Frames prefer it and
   * fall back to the WebSocket whenever no client is attached to it.
   */
  webtransport?: {
    port: number;
    certHash: string | null;
    hasSession: boolean;
    /** Bytes written to QUIC but not yet flushed; the congestion signal there. */
    backlogBytes: number;
    send(payload: Uint8Array): Promise<boolean>;
  };
  /**
   * Overrides the Classic backpressure threshold (see MAX_QUEUED_FRAME_BYTES).
   * Test-only escape hatch: a loopback socket drains far too fast to build a
   * real backlog on demand, so the drop path can only be exercised by moving
   * the threshold. Omit in real usage.
   */
  maxQueuedFrameBytes?: number;
}

const SCREENSHOT_INTERVAL = 2000;

/** Minimal HTML escaping for the nickname shown on the cert-acceptance page. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Constant-time secret comparison to avoid leaking length/content via timing. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * How many bytes may sit unsent in the controller socket before Classic frames
 * start being dropped instead of queued.
 *
 * Classic is MJPEG: every frame is a full intra frame, ~90-270KB at the sizes
 * this agent captures (measured: 267KB at 1920 wide, q:v 6). At the 120fps the
 * client requests on a 120Hz display that is ~206 Mbit/s, which no WiFi or
 * Tailscale link carries. Without a ceiling, ws simply queues the surplus in
 * memory: the backlog grew by roughly the difference every second, so the
 * picture fell steadily further behind real time and never recovered. That is
 * the "Classic starts lagging after 10-15s" symptom -- not dropped frames, and
 * not a scaling bug, but unbounded queueing.
 *
 * Two frames' worth. Big enough that ordinary jitter doesn't cause drops, small
 * enough that the displayed frame is never more than a frame or two old. This
 * is the same drop-stale policy the client already applies on receive (see
 * useConnection's handleFrame): for a live screen, a queued frame is worthless
 * the instant a newer one exists, so dropping is strictly correct rather than a
 * compromise.
 *
 * H.264 sends far less (measured ~7.4KB/frame against MJPEG's ~267KB), so
 * this ceiling is reached rarely on that path — but it is what keeps a
 * saturated link from queueing rather than dropping, on either codec.
 */
const MAX_QUEUED_FRAME_BYTES = 512 * 1024;
/**
 * Queue ceiling once the viewer has PINNED a resolution.
 *
 * Auto mode stays real-time by discarding frames — an unbounded queue is what
 * made Classic drift permanently behind (see MAX_QUEUED_FRAME_BYTES). Pinning
 * a rung is an explicit request for that size regardless of the link, so
 * frames are allowed to queue instead, the way a video player buffers. Still
 * bounded: past this the link is not merely slow, and dropping beats consuming
 * memory without limit.
 */
const BUFFERED_MAX_QUEUED_FRAME_BYTES = 8 * 1024 * 1024;

/** Minimum gap between "dropping frames" log lines. */
const DROP_LOG_THROTTLE_MS = 5000;

/**
 * Bitrate bounds and step sizes for the adaptive controller below.
 *
 * The floor is chosen so a saturated link still carries a legible desktop
 * rather than degrading to mush; the ceiling is what a good LAN can spend
 * without the encoder becoming the limit. Steps are asymmetric on purpose:
 * congestion is an emergency and should be answered immediately, while
 * recovery should be cautious, because probing upward too eagerly re-creates
 * the congestion that was just escaped.
 */
const BITRATE_MIN_KBPS = 400;
/**
 * Ceiling at the 1920px baseline this was originally tuned against, raised
 * for LAN.
 *
 * Resolution and bitrate are not independent: spreading 6 Mbit/s over a native
 * desktop looks SOFTER than the same bits over 1280px, because quality is
 * bits-per-pixel. The encode width now defaults to the agent's actual screen
 * width instead of a fixed 1920 (see agent/src/index.ts), so this baseline is
 * scaled by bitrateCeilingKbps() below for a session that started wider —
 * otherwise a good link on a high-resolution display would still spread this
 * same 20000kbps over far more pixels than it was tuned for, undoing the
 * point of streaming at native resolution at all. The controller still walks
 * down from here on any link that cannot sustain it, so a constrained
 * connection never pays for the higher ceiling.
 */
const BITRATE_MAX_KBPS_AT_1920 = 1_000_000;
/** Upper bound on the scaled ceiling, so an unusually large display doesn't imply a bitrate no real network can sustain. */
const BITRATE_MAX_KBPS_CAP = 1_000_000;

/**
 * How far the target must drift from what the encoder was last told before it
 * is worth telling it again.
 *
 * Every change reopens the encoder and forces a keyframe. A 15% ramp step is
 * not worth that; a change of a quarter is. Bounds are always applied
 * regardless, since sitting just short of the floor or ceiling is exactly the
 * case where the remaining difference matters.
 */
const BITRATE_APPLY_THRESHOLD = 0.25;

const BITRATE_DOWN_FACTOR = 0.6;
const BITRATE_UP_FACTOR = 1.15;

/** How often the controller reconsiders quality. */
const ADAPT_INTERVAL_MS = 2000;

/** How often the measured stream rate is recomputed and reported to the viewer. */
const REPORT_INTERVAL_MS = 2000;

/** How often close() re-destroys leftover sockets, and how long it tries. */
const SHUTDOWN_SWEEP_MS = 50;
const SHUTDOWN_GRACE_MS = 2000;

/**
 * Each resolution rung is this fraction of the previous rung's width.
 *
 * Chosen small deliberately: Chrome's own WebRTC video pipeline (the
 * QualityScaler behind `degradationPreference`) scales resolution in
 * continuous, similarly-sized steps driven by encoder feedback, rather than
 * jumping between a handful of fixed named resolutions the way traditional
 * on-demand ABR ladders (HLS/DASH) do — a live remote-control picture has no
 * time to smooth over a big visible jump the way a buffered video player
 * does. 0.8 gives a fine-grained descent (roughly a dozen rungs from 1920 down
 * to the 320px floor) instead of a couple of large cuts.
 */
const LADDER_WIDTH_STEP = 0.8;
/** Once width has dropped to this fraction of the starting width, fps may also drop to LADDER_LOW_FPS. */
const LADDER_LOW_FPS_WIDTH_FRACTION = 0.5;
const LADDER_MID_FPS = 30;
const LADDER_LOW_FPS = 15;
/** Matches H264Capture.setScale's own floor. */
const LADDER_MIN_WIDTH = 320;

/**
 * Builds the resolution/fps fallback ladder relative to the width and fps a
 * session actually started at, rather than a fixed absolute table.
 *
 * A fixed table starting at 1920 broke once maxWidth started defaulting to
 * the agent's native screen width: the very first step down would drop a
 * larger native resolution straight to 1920 in one jump, and climbing back up
 * could only ever reach 1920 again — the session's real starting resolution
 * was gone for good once any congestion happened at all, even briefly.
 *
 * Same philosophy as before — resolution is given up before frame rate,
 * because a slightly smaller sharp image beats a large mushy one, and frame
 * rate only drops once the picture is already small — but as a continuous
 * proportional descent (see LADDER_WIDTH_STEP) instead of a few large,
 * perceptible jumps. Widths are kept even (yuv420p needs it).
 */
export function buildQualityLadder(
  startWidth: number,
  startFps: number,
): ReadonlyArray<{ width: number; fps: number }> {
  const bestFps = Math.min(60, startFps);
  const rungs: Array<{ width: number; fps: number }> = [{ width: startWidth, fps: bestFps }];
  if (bestFps > LADDER_MID_FPS) rungs.push({ width: startWidth, fps: LADDER_MID_FPS });

  let width = startWidth;
  let fps = Math.min(bestFps, LADDER_MID_FPS);
  for (;;) {
    const next = Math.max(LADDER_MIN_WIDTH, Math.round((width * LADDER_WIDTH_STEP) / 2) * 2);
    if (next === width) break; // rounding has converged at the floor
    width = next;
    if (width <= startWidth * LADDER_LOW_FPS_WIDTH_FRACTION) fps = LADDER_LOW_FPS;
    rungs.push({ width, fps });
  }
  return rungs;
}

/**
 * Consecutive healthy checks required before climbing back up a rung.
 *
 * Stepping resolution reopens the encoder and forces a keyframe, which is a
 * visible cost, so it must not oscillate. Coming down is immediate — congestion
 * is already hurting — but going up waits for sustained evidence that the link
 * can hold it.
 */
const LADDER_RECOVERY_CHECKS = 5;

/**
 * Consecutive congested-at-the-floor checks required before giving up a rung.
 *
 * Without this the descent is unstoppable: bitrate takes ~27 ticks to climb
 * from the floor to a ceiling (x1.15 each), while the ladder was dropping a
 * rung EVERY tick that bitrate sat at the floor. Any event that parks bitrate
 * low -- a burst of congestion, or simply un-pinning a resolution after the
 * controller had wound bitrate down -- therefore walked the picture from full
 * size to the 320px floor in about twenty seconds, and recovery then needed
 * five clean checks per rung to undo it.
 *
 * Requiring confirmation gives bitrate room to prove whether the CURRENT rung
 * is actually unsustainable before spending another one.
 */
const LADDER_DOWN_CONFIRM = 3;

/**
 * Bitrate ceiling for a given encode width, scaled by pixel AREA relative to
 * the 1920px baseline BITRATE_MAX_KBPS_AT_1920 was tuned against — area, not
 * width, is what "bits per pixel" means, and for a fixed aspect ratio area
 * scales with width squared.
 *
 * The ceiling MUST track the current rung rather than being pinned to the
 * 1920 baseline. The controller only climbs back up the quality ladder once
 * bitrate has reached this ceiling, so a ceiling that stays at 20000kbps no
 * matter how small the picture got asks a link to sustain 20 Mbit/s before it
 * may return to full resolution — bits the small encode could not spend even
 * if the link delivered them. A link that just congested never gets there, so
 * every step down was permanent for the rest of the session.
 *
 * Falls back to the baseline when the active capture engine exposes no
 * encodeWidth (the screenshot-desktop path, which has no bitrate control to
 * begin with).
 */
export function bitrateCeilingForWidth(width: number | undefined): number {
  return scaleByArea(width, BITRATE_MAX_KBPS_AT_1920, BITRATE_MAX_KBPS_CAP);
}

/**
 * Headroom this width keeps regardless of what is currently being carried, so
 * a still picture is not strangled the instant it starts moving.
 *
 * Scaled by area like the ceiling: fewer pixels need less of a cushion.
 */
export function responsivenessFloorForWidth(width: number | undefined): number {
  return scaleByArea(
    width,
    BITRATE_RESPONSIVENESS_FLOOR_AT_1920,
    BITRATE_RESPONSIVENESS_FLOOR_AT_1920,
  );
}

/** Area-scales `baseline` from 1920px to `width`, bounded by the floor and `cap`. */
function scaleByArea(width: number | undefined, baseline: number, cap: number): number {
  if (!width) return baseline;
  const scaled = Math.round(baseline * (width / 1920) ** 2);
  return Math.min(cap, Math.max(BITRATE_MIN_KBPS, scaled));
}

/**
 * How far above the rate actually being carried the target may climb.
 *
 * WebRTC bounds its estimate to roughly this multiple of the ACKED rate, and
 * for the same reason: a target far above anything the link has been observed
 * to carry is a guess with no evidence behind it. Without the bound the target
 * simply ratchets +BITRATE_UP_FACTOR every tick for as long as nothing
 * congests, which on a quiet link compounds to ten times in half a minute --
 * measured running to 770Mbit/s against a stream genuinely costing 1.8Mbit/s.
 * That is not free: it is the number handed to the encoder, and the moment the
 * content stops being quiet the encoder is entitled to spend all of it, in one
 * burst, on a link that was never tested at anything like that rate.
 *
 * 1.5 leaves ample room to grow -- 50% per tick, far more than the 15% the
 * controller actually steps -- so this never binds while the encoder is really
 * using its budget. It binds only when the budget is fiction.
 */
const BITRATE_MEASURED_HEADROOM = 1.5;

/**
 * Where the target lands when congestion is detected and the carried rate is
 * known: just under what the link has been shown to manage.
 *
 * Multiplying the previous TARGET down instead is a blind step, and its size is
 * wrong whenever the target has drifted away from reality. Measured against a
 * link collapsing from 10Mbit/s to 800kbit/s, the target sat at 20Mbit/s: at
 * BITRATE_DOWN_FACTOR per tick that is nine ticks -- eighteen seconds of the
 * encoder being told it may spend twenty times what the link can carry, which
 * is eighteen seconds of the viewer watching a slideshow. Aiming at the carried
 * rate gets there in one.
 *
 * The same 0.85 WebRTC uses, and for the same reason: landing exactly ON the
 * observed rate leaves nothing spare to drain the queue that congestion just
 * built.
 */
const BITRATE_DECREASE_OF_ACKED = 0.85;

/**
 * Carrying at least this fraction of the target counts as the encoder being
 * short of bits: it is spending nearly everything it is allowed, so the
 * constraint is the budget rather than the content.
 */
const BITRATE_STARVED_FRACTION = 0.85;

/**
 * Smallest budget the measured-throughput bound may impose, at 1920px.
 *
 * Bounding hard against what is currently carried is right for congestion
 * control and wrong for a screen, which is mostly still and then abruptly is
 * not. A desktop idling at 200kbit/s would be held to a 300kbit/s budget, and
 * the moment a video started or a window was dragged the encoder would be
 * strangled for the many ticks it takes +BITRATE_UP_FACTOR to climb back.
 *
 * So the bound never falls below this. That is not an assumption about the link
 * -- congestion still overrides it in one step, aimed at the carried rate -- it
 * is headroom for content that changes faster than the controller can measure.
 *
 * Sized for what a BUSY screen of this many pixels costs, not for what an idle
 * one happens to be spending. At 2500 it was sized for neither: a 1080p session
 * reported a 2.4Mbit/s budget on a link with far more to give, because the
 * budget only ever grew from what quiet content asked for, and a link is never
 * asked for more than the budget allows. The first time the picture got busy the
 * encoder would be held to that, climbing BITRATE_UP_FACTOR per tick -- some
 * twenty seconds of soft picture to reach a rate the link had all along.
 *
 * Still two orders of magnitude below BITRATE_MAX_KBPS_CAP, so it cannot
 * reintroduce the runaway the bound exists to prevent.
 */
const BITRATE_RESPONSIVENESS_FLOOR_AT_1920 = 8000;

/**
 * Decides the next bitrate target.
 *
 * Pure so the rate rule can be tested without a link: it is the piece that has
 * been wrong most often, and it was previously reachable only through a live
 * socket.
 */
export function nextBitrateKbps(input: {
  previous: number;
  congested: boolean;
  ceilingKbps: number;
  /** Floor for the measured-throughput bound; see nextBitrateKbps's body. */
  floorKbps: number;
  /** Bytes actually carried, or null before the first window has elapsed. */
  measuredKbps: number | null;
  /**
   * The delay gradient says the queue built by congestion is still draining.
   * Adding to it now simply refills it, so the target holds where it is.
   */
  draining?: boolean;
}): number {
  const { previous, congested, ceilingKbps, floorKbps, measuredKbps, draining } = input;

  if (congested) {
    const blind = Math.round(previous * BITRATE_DOWN_FACTOR);
    // Aim just under what the link is actually carrying, when that is known.
    // Never ABOVE the blind step, so a stale or optimistic measurement can only
    // make the response more decisive, never less.
    const aimed =
      measuredKbps === null
        ? blind
        : Math.min(blind, Math.round(measuredKbps * BITRATE_DECREASE_OF_ACKED));
    return Math.max(BITRATE_MIN_KBPS, aimed);
  }

  if (draining) return previous;

  const raised = Math.round(previous * BITRATE_UP_FACTOR);

  // Bounded by what is actually being carried, but never squeezed below the
  // responsiveness floor -- see BITRATE_RESPONSIVENESS_FLOOR_AT_1920.
  const evidenceBound =
    measuredKbps === null
      ? ceilingKbps
      : Math.max(Math.round(measuredKbps * BITRATE_MEASURED_HEADROOM), floorKbps);

  // The bound caps GROWTH; it must never drag a healthy target downward.
  //
  // Applied as a plain minimum it did exactly that, and the result was a
  // permanent oscillation: the bound follows measured throughput, measured
  // throughput wobbles across it, so the target was pulled down to the bound
  // and ramped back up on alternate ticks, forever, both steps logged as "link
  // healthy". Every one of those steps reopens the encoder and forces a
  // keyframe, so a link with nothing wrong with it rebuilt its encoder every
  // two seconds -- which is visible to the viewer as frame rate that will not
  // settle.
  //
  // Holding instead costs nothing. A target above what the content is spending
  // is not spent either; the encoder simply does not use it. Only congestion
  // brings the target down, which is the one signal that should.
  if (previous >= evidenceBound) return previous;
  return Math.min(ceilingKbps, evidenceBound, raised);
}

/** Ladder state the controller carries between adaptation ticks. */
export interface LadderState {
  rung: number;
  healthyChecks: number;
  /** Consecutive congested-at-the-floor checks; see LADDER_DOWN_CONFIRM. */
  floorChecks?: number;
}

/**
 * Decides whether to move a rung this tick. Pure so the escalation and
 * recovery rules can be tested directly.
 *
 * Down is immediate once bitrate has bottomed out; up requires
 * LADDER_RECOVERY_CHECKS consecutive ticks at the (rung-relative) proven rate,
 * because reopening the encoder forces a keyframe and must not oscillate.
 */
export function decideLadderMove(
  state: LadderState,
  input: { congested: boolean; bitrateKbps: number; starved: boolean; rungCount: number },
): LadderState & { moved: "down" | "up" | null } {
  const { congested, bitrateKbps, starved, rungCount } = input;

  // Give up pixels only once bitrate has stopped being the answer.
  //
  // This used to ask whether the target had reached its FLOOR, which worked
  // only because the old decrease ground blindly downward until it got there.
  // Now that congestion aims the target straight at the rate the link is
  // carrying, the target settles where it belongs and essentially never
  // bottoms out -- so the ladder stopped engaging at all, however bad the link
  // got. The honest question is the mirror of the climb above: the link is
  // still congesting AND the encoder is already spending everything it is
  // allowed, so there are no bits left to find and the only remaining lever is
  // fewer pixels.
  if (congested && starved) {
    const floorChecks = (state.floorChecks ?? 0) + 1;
    const canDescend = state.rung < rungCount - 1 && floorChecks >= LADDER_DOWN_CONFIRM;
    return {
      rung: canDescend ? state.rung + 1 : state.rung,
      healthyChecks: 0,
      // Reset after a move: the next rung earns its own confirmation rather
      // than inheriting evidence gathered against a larger picture.
      floorChecks: canDescend ? 0 : floorChecks,
      moved: canDescend ? "down" : null,
    };
  }

  // Climb when the link is quiet AND the encoder has bits to spare.
  //
  // This used to ask whether the TARGET had reached a fixed rate, which was
  // never really a question about the link: a still desktop costs almost
  // nothing to encode however much bandwidth is available, so the only way the
  // target ever got there was by ratcheting up on its own. That made the
  // ladder's evidence a number the controller had written itself.
  //
  // What actually decides whether more pixels are affordable is whether the
  // encoder is short of bits at the size it is already at. If it is spending
  // everything it is allowed, more pixels would only spread the same bits
  // thinner, and the answer is more bitrate, not more resolution -- which the
  // loop above is already pursuing. If it is comfortably inside its budget,
  // the picture can afford to grow. This is the question WebRTC's QualityScaler
  // asks of encoder QP; `starved` is the same question asked of throughput,
  // which is what this agent can see.
  if (!congested && !starved) {
    const checks = state.healthyChecks + 1;
    if (checks >= LADDER_RECOVERY_CHECKS && state.rung > 0) {
      return { rung: state.rung - 1, healthyChecks: 0, floorChecks: 0, moved: "up" };
    }
    return { rung: state.rung, healthyChecks: checks, floorChecks: 0, moved: null };
  }

  return { rung: state.rung, healthyChecks: 0, floorChecks: 0, moved: null };
}


/**
 * Traces every adaptation tick, including the ones that change nothing.
 *
 * Diagnostic only, off by default: one line every ADAPT_INTERVAL_MS is far too
 * much for an ordinary session, but it is the only way to see WHY a stuck
 * session is stuck, since the change-log is silent exactly when the controller
 * has stopped moving. Enable with BCSA_DEBUG_ADAPT=1.
 */
const DEBUG_ADAPT = process.env.BCSA_DEBUG_ADAPT === "1";

/**
 * The agent's WSS server. Accepts a single authenticated controller at a time,
 * streams screen frames to it, and applies its mouse/keyboard/autotype commands.
 */
export class ConnectionServer {
  private https: HttpsServer | null = null;
  private wss: WebSocketServer | null = null;
  private controller: WebSocket | null = null;
  /**
   * Applies volume changes, keeping only the newest of any burst.
   *
   * A dragged slider sends far more changes than the OS can apply, and the one
   * that matters is the one it was released on. See CoalescingApplier.
   */
  private readonly volumeApplier = new CoalescingApplier<number>((level) =>
    this.deps.volume.setLevel(level),
  );
  private seq = 0;
  private audioSeq = 0;
  private autotyping = false;

  /**
   * Whether a run is in progress, for anything that must not react to the
   * agent's own keystrokes -- see registerLockHotkey's `suppressed` option.
   */
  get isAutotyping(): boolean {
    return this.autotyping;
  }
  private autotypeAbort: AbortController | null = null;
  /** Frames dropped for backpressure since the last log line. */
  private droppedFrames = 0;
  private lastDropLogAt = 0;
  /** Current adaptive target; null until a capture engine that supports it starts. */
  private bitrateKbps: number | null = null;
  /**
   * What the encoder was last actually told, which lags the target on purpose;
   * see BITRATE_APPLY_THRESHOLD.
   */
  private appliedBitrateKbps: number | null = null;
  private adaptTimer: NodeJS.Timeout | null = null;
  /** Worst queue depth seen since the last adaptation decision; reported, not acted on. */
  private peakBacklog = 0;
  /**
   * Frame bytes handed to a transport since the last measurement, and when that
   * window opened. This is what the viewer's strip reports: the target bitrate
   * is a budget, and a static desktop spends a small fraction of it.
   */
  private sentBytes = 0;
  private measureWindowAt = Date.now();
  /** Most recent measured rate, in kbit/s; null until a window has elapsed. */
  private measuredKbps: number | null = null;
  private measureTimer: NodeJS.Timeout | null = null;
  /**
   * Delay-gradient congestion detector, running in the SHADOW: it is fed real
   * timings and logged beside the live queue-depth signal, but decides nothing.
   * The two are being compared on real links before either is trusted alone.
   */
  private readonly trendline = new TrendlineEstimator();
  /** Highest frame seq the estimator has consumed; guards replayed feedback. */
  private lastFeedbackSeq = -1;
  /** Refuses to believe a transport backlog that has stopped moving. */
  private readonly stuckBacklog = new StuckBacklogDetector();
  /** What the CLIENT reports receiving; the anchor for the bitrate target. */
  private readonly ackedRate = new AckedRateTracker();
  /**
   * Smooths frames onto the wire. Constructed once and pointed at whichever
   * transport is live at the moment each frame is released, so a session that
   * gains or loses QUIC mid-stream keeps its pacing.
   */
  private readonly pacer = new FramePacer({
    send: (frame) => this.sendPaced(frame),
  });
  /**
   * SHALLOWEST queue depth seen since the last adaptation decision — the part
   * of the queue that never drained. This, not the peak, is the congestion
   * signal, kept for the trace now that congestion is decided by the receiver
   * rather than by our own queue. `null` when no frame was captured during
   * the window, in which case the live depth is used instead.
   */
  private troughBacklog: number | null = null;
  /** Built once, from the width/fps the session actually started at — see buildQualityLadder. */
  private ladder: ReadonlyArray<{ width: number; fps: number }> | null = null;
  /**
   * The encoder's untouched starting geometry, captured before any adaptation.
   *
   * The ladder MUST be derived from this rather than from the live
   * encodeWidth. Reading the live width meant that if the cache was ever built
   * while the encoder was already scaled down, the reduced width became rung 0
   * — "best quality" — and the session could never climb above it again. The
   * signature was a bottom-rung width reported at the full refresh rate
   * (e.g. 320px @ 59fps), a pairing the real ladder never produces because it
   * drops fps long before reaching its narrowest rung.
   */
  private baselineWidth: number | null = null;
  /** "manual" once the viewer pins a rung; the ladder stops moving. */
  private qualityMode: "auto" | "manual" = "auto";
  /** The pinned geometry, when qualityMode is "manual". */
  private pinned: { width: number; fps: number } | null = null;
  /** Frames are queueing rather than being dropped (manual mode only). */
  private buffering = false;
  /** Index into this.ladder; 0 is best. */
  private ladderRung = 0;
  /** Consecutive healthy checks, for cautious recovery up the ladder. */
  private healthyChecks = 0;
  /** Consecutive congested-at-the-floor checks; see LADDER_DOWN_CONFIRM. */
  private floorChecks = 0;
  /** Rung the ladder was on before a manual pin, so un-pinning can return to it. */
  private rungBeforePin: number | null = null;
  /** Frames dropped since the last adaptation decision. */
  private dropsSinceAdapt = 0;

  constructor(private readonly deps: ServerDeps) {}

  listen(): Promise<void> {
    // A minimal request handler is essential: browsers refuse a wss:// connection
    // to an untrusted self-signed cert until the user has accepted it, and the
    // only way to accept it is to load https://<agent>:<port> in a tab. Without
    // a handler that request hangs with no response, so the cert never gets
    // trusted and the client can never connect. This page also serves as a
    // reachability check ("if you see this, the client can reach the agent").
    this.https = createServer(
      { cert: this.deps.tls.cert, key: this.deps.tls.key },
      (req, res) => {
        if (this.deps.clientDir && this.serveClient(req.url ?? "/", res)) return;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8">` +
            `<title>Beamdesk agent</title>` +
            `<body style="font-family:system-ui;max-width:32rem;margin:3rem auto;line-height:1.5">` +
            `<h1>✅ Agent reachable</h1>` +
            `<p>You've reached the <strong>${escapeHtml(this.deps.nickname)}</strong> agent and accepted its certificate.</p>` +
            `<p>You can close this tab and press <strong>Connect</strong> in the client.</p>` +
            `</body>`,
        );
      },
    );
    this.wss = new WebSocketServer({ server: this.https });
    this.wss.on("connection", (ws) => this.onConnection(ws));

    return new Promise((resolve) => {
      this.https!.listen(this.deps.port, this.deps.host, () => resolve());
    });
  }

  /**
   * Serves the built client from the agent itself, so the UI is reachable from
   * anywhere the agent is.
   *
   * This is not merely convenient. Serving the page from the SAME origin as the
   * WebSocket removes the sharpest edge in the whole setup: a browser refuses a
   * wss:// connection to an untrusted certificate, gives the page no way to
   * learn why, and that certificate must be accepted separately for every
   * address the agent advertises. When the page itself came from
   * https://<agent>:<port>, accepting it once covers the socket too, because
   * they are the same origin.
   *
   * It also means there is no second server to run, and the UI works over a
   * Cloudflare Tunnel, which forwards exactly one HTTP origin.
   *
   * Returns false when the request is not for a file this should serve, so the
   * caller can fall back to the reachability page.
   */
  private serveClient(url: string, res: import("node:http").ServerResponse): boolean {
    const root = this.deps.clientDir;
    if (!root) return false;

    const requested = decodeURIComponent(url.split("?")[0] ?? "/");
    // Resolve inside the client directory and verify containment. Serving files
    // by path from a request is the classic directory-traversal sink, and this
    // process can read the user's whole home directory.
    const candidate = resolvePath(join(root, normalize(requested)));
    const inside = candidate === root || candidate.startsWith(root + sep);
    if (!inside) {
      res.writeHead(403).end();
      return true;
    }

    // A single-page app owns its routing: any path that is not a real file is
    // served the entry document so a deep link still loads the app.
    const file =
      existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, "index.html");
    if (!existsSync(file)) return false;

    const types: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json",
      ".wasm": "application/wasm",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".woff2": "font/woff2",
    };
    res.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
      // The transcription models are large and content-hashed by the build;
      // re-downloading them on every load would dominate startup.
      "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000",
    });
    createReadStream(file).pipe(res);
    return true;
  }

  /** The actual bound port (useful when constructed with port 0 in tests). */
  boundPort(): number {
    const addr = this.https?.address() as AddressInfo | null;
    return addr ? addr.port : this.deps.port;
  }

  async close(): Promise<void> {
    this.stopAdapting();
    this.deps.capture.stop();
    this.deps.audio.stop();
    await this.deps.inputLock.unlock();
    await this.deps.input.releaseAllKeys().catch(() => {});
    this.deps.input.stop();
    this.deps.typingBackend.dispose?.();
    this.controller?.close();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      // wss.close() waits for every client to finish its close handshake, and a
      // peer that has gone away never sends one. Shutdown cannot be held
      // hostage by a half-open tab.
      for (const client of this.wss.clients) client.terminate();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      const https = this.https;
      if (!https) return resolve();
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearInterval(sweep);
        clearTimeout(cap);
        resolve();
      };
      https.close(() => finish());
      // Idle keep-alive sockets are why close() alone was not enough.
      //
      // Node counts a connection as outstanding until it actually ends, and an
      // idle one never does -- a browser leaves several behind after fetching
      // the certificate-accept page. close() therefore waited forever, the
      // SIGINT handler in index.ts never reached process.exit(0), and Ctrl+C
      // printed "Shutting down..." and then hung with no way out but kill -9.
      //
      // Swept rather than called once: closeAllConnections() destroys only the
      // sockets the server has registered SO FAR, and a TLS handshake still in
      // flight lands after it, holding the server open just as before.
      https.closeAllConnections();
      const sweep = setInterval(() => https.closeAllConnections(), SHUTDOWN_SWEEP_MS);
      sweep.unref?.();
      // Last resort. Whatever a socket manages to do, quitting must terminate.
      const cap = setTimeout(finish, SHUTDOWN_GRACE_MS);
      cap.unref?.();
    });
  }

  private send(ws: WebSocket, msg: AgentMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(encodeMessage(msg));
  }

  /**
   * Lazily built from the encoder's ORIGINAL geometry (see buildQualityLadder
   * and baselineWidth) — never from the live width, which may already be
   * degraded.
   */
  private getLadder(): ReadonlyArray<{ width: number; fps: number }> {
    if (!this.ladder) {
      this.rememberBaseline();
      this.ladder = buildQualityLadder(this.baselineWidth ?? 1920, this.deps.refreshHz);
    }
    return this.ladder;
  }

  /** Latches the encoder's pre-adaptation geometry the first time it is seen. */
  private rememberBaseline(): void {
    if (this.baselineWidth !== null) return;
    this.baselineWidth = this.deps.capture.encodeWidth ?? null;
  }

  /**
   * Returns the encoder to full quality and forgets the session's ladder.
   *
   * Without this a congested session left the encoder scaled down for the
   * whole life of the agent process: the next client reset ladderRung to 0 —
   * "we are at the top" — while the picture was still at the narrow width the
   * previous session ended on, so nothing ever stepped it back up.
   */
  private restoreBaselineQuality(): void {
    if (this.baselineWidth === null || !this.deps.capture.setScale) return;
    // Restore rung 0 itself rather than a remembered fps. The live encodeFps
    // is mode-dependent -- a screenshot-mode session runs at well under 1fps,
    // and latching THAT as the baseline stranded the next session at 1fps.
    // Rung 0 is by definition what "full quality" means for this session.
    const top = this.getLadder()[0];
    this.deps.capture.setScale(top.width, top.fps);
    process.stderr.write(
      `[adapt] quality reset -> ${top.width}px @ ${top.fps}fps (session ended)\n`,
    );
  }

  /**
   * Bitrate ceiling for the resolution this session actually started at.
   *
   * Delegates to the pure bitrateCeilingForWidth() so the rule can be tested
   * without standing up a server.
   */
  private bitrateCeilingKbps(): number {
    return bitrateCeilingForWidth(this.deps.capture.encodeWidth);
  }

  /**
   * Adjusts encoder bitrate to what the link is actually carrying.
   *
   * The signal is the socket's own send queue. That is a real measurement of
   * whether the far end is keeping up — unlike a fixed bitrate, which is a
   * guess that is wrong in both directions: too high on a poor link (frames
   * queue, then get dropped, and the picture stutters) and too low on a good
   * one (bandwidth sits unused while the image stays soft).
   *
   * Down fast, up slow. Congestion is already hurting the viewer when it is
   * detected, so it is answered in one large step; recovery probes gently,
   * because climbing back too eagerly just re-creates the congestion. This is
   * the same asymmetry TCP uses, for the same reason.
   *
   * Cheap enough to do continuously: reopening the encoder measures ~2.2ms,
   * against ~300ms plus a capture-device reopen when the encoder was an ffmpeg
   * subprocess — which is precisely why this was not worth attempting before.
   */
  private startAdapting(): void {
    if (this.adaptTimer || !this.deps.capture.setBitrate) return;
    this.bitrateKbps ??= this.deps.initialBitrateKbps ?? 2500;
    this.pacer.setTargetKbps(this.bitrateKbps);
    this.appliedBitrateKbps = null;
    // Open the measurement window HERE, not at construction. An agent that sat
    // idle for a minute before a viewer arrived otherwise divided the first
    // window's bytes by that whole minute, and the strip opened on a rate about
    // a tenth of the truth before correcting itself.
    this.adaptTimer = setInterval(() => {
      const ws = this.controller;
      if (!ws || ws.readyState !== ws.OPEN || this.bitrateKbps === null) return;

      // Read the queue of whichever transport is actually carrying video.
      //
      // Using the WebSocket's queue unconditionally was wrong once QUIC
      // existed: on that path the socket carries only control messages, so it
      // always looked idle and the controller raised the bitrate to the ceiling
      // no matter how congested the link really was.
      const wt = this.deps.webtransport;
      const live = wt?.hasSession ? wt.backlogBytes : ws.bufferedAmount;
      const peak = Math.max(this.peakBacklog, live);
      // The queue that survived the whole window, not the tallest it ever got.
      const standing = Math.min(this.troughBacklog ?? live, live);
      const drops = this.dropsSinceAdapt;
      this.peakBacklog = 0;
      this.troughBacklog = null;
      this.dropsSinceAdapt = 0;

      // Congestion is what the RECEIVER saw, plus frames we could not deliver.
      //
      // Our own queue depth used to count too, and no longer does. It was never
      // able to see a bottleneck further out than our own send buffer -- against
      // a link collapsing from 10Mbit/s to 800kbit/s it reported perfect health
      // throughout, while the gradient called it on six ticks out of seven --
      // so it added nothing the gradient did not catch earlier. What it did add
      // was a way to be wrong that a network measurement cannot be: it is local
      // state, and a stranded write once left it frozen at 633KB for an entire
      // session, which read as a permanently congested link and walked the
      // picture from 1920p down to 320p. A signal that can only lag or lie is
      // not worth consulting; `standing` is still logged, but it decides
      // nothing.
      const gradient = this.trendline.current();
      const congested = drops > 0 || gradient === "overusing";
      const ceiling = this.bitrateCeilingKbps();

      // Every tick, not just the ones that change something.
      //
      // The interesting state is precisely the one the change-log cannot show:
      // parked at the bitrate floor, where `next === previous` and this loop
      // returns below without printing anything. A session stuck at 0.4Mbps
      // therefore produced an EMPTY log, with no way to tell a genuinely
      // saturated link from a congestion signal that never clears.
      const { trend, threshold, samples } = this.trendline.detail();
      // Prefer what the client says it RECEIVED over what we say we sent: with
      // a bottleneck downstream of our own socket, the agent can pour bytes
      // into a buffer it cannot see past and count them all as progress.
      const ackedKbps = this.ackedRate.rateKbps();

      if (DEBUG_ADAPT) {
        process.stderr.write(
          `[adapt:tick] ${this.bitrateKbps}kbps/${ceiling} ${this.qualityMode} ` +
            `rung=${this.ladderRung} congested=${congested} ` +
            `standing=${(standing / 1024).toFixed(0)}KB (live ${(live / 1024).toFixed(0)}KB, ` +
            `peak ${(peak / 1024).toFixed(0)}KB) drops=${drops} ` +
            `via=${wt?.hasSession ? "quic" : "ws"} wsBuf=${(ws.bufferedAmount / 1024).toFixed(0)}KB ` +
            `| gradient=${gradient} trend=${trend.toFixed(3)} thr=${threshold.toFixed(1)} n=${samples} ` +
            `acked=${this.ackedRate.rateKbps() ?? "-"}kbps sent=${this.measuredKbps ?? "-"}kbps\n`,
        );
      }

      // Resolution and frame rate move only when bitrate has run out of room.
      // Bitrate is the cheap, invisible lever; changing frame size reopens the
      // encoder and forces a keyframe, so it is reserved for links that cannot
      // be rescued by spending fewer bits on the same picture.
      // A pinned rung is the viewer's explicit choice; the controller must not
      // move resolution underneath them. Bitrate still adapts below.
      if (this.deps.capture.setScale && this.qualityMode === "auto") {
        const decision = decideLadderMove(
          {
            rung: this.ladderRung,
            healthyChecks: this.healthyChecks,
            floorChecks: this.floorChecks,
          },
          {
            congested,
            bitrateKbps: this.bitrateKbps,
            // Spending nearly the whole budget means the encoder wants bits,
            // not pixels. Unknown throughput counts as starved: without
            // evidence the picture must not grow.
            starved:
              ackedKbps === null ||
              ackedKbps >= this.bitrateKbps * BITRATE_STARVED_FRACTION,
            rungCount: this.getLadder().length,
          },
        );
        this.ladderRung = decision.rung;
        this.healthyChecks = decision.healthyChecks;
        this.floorChecks = decision.floorChecks ?? 0;
        if (decision.moved === "down") this.applyRung("congested with no bitrate left to give");
        if (decision.moved === "up") this.applyRung("link quiet with bitrate to spare");
      }

      const previous = this.bitrateKbps;
      const next = nextBitrateKbps({
        previous,
        congested,
        ceilingKbps: ceiling,
        floorKbps: responsivenessFloorForWidth(this.deps.capture.encodeWidth),
        measuredKbps: ackedKbps ?? this.measuredKbps,
        // Hold while the queue congestion built is still draining; adding to it
        // now just refills it.
        draining: gradient === "underusing",
      });

      // Ignore changes too small to matter: every adjustment reopens the
      // encoder and emits a keyframe, which costs far more bytes than a 3%
      // bitrate tweak would ever save.
      //
      // Except when the step lands on a bound. Suppressing those strands the
      // controller just short of its own floor — a 420 -> 400 step is under
      // 10%, so it was skipped forever, and the quality ladder below (which
      // only engages AT the floor) could never trigger no matter how congested
      // the link became.
      // The TARGET moves every tick. What the encoder is TOLD moves rarely.
      //
      // Reopening the encoder costs a keyframe, and a keyframe is tens of
      // ordinary frames' worth of bytes, so applying every step of an ordinary
      // AIMD sawtooth rebuilt the encoder every two seconds on a link with
      // nothing wrong with it -- which the viewer sees as a frame rate that
      // will not settle. Control and application are different questions: the
      // controller needs to track the link closely, the encoder only needs to
      // be roughly right, and the difference between them is free.
      this.bitrateKbps = next;
      this.pacer.setTargetKbps(next);

      const applied = this.appliedBitrateKbps;
      const atBound = next === BITRATE_MIN_KBPS || next === ceiling;
      const worthApplying =
        applied === null ||
        atBound ||
        Math.abs(next - applied) >= applied * BITRATE_APPLY_THRESHOLD;

      if (worthApplying && next !== applied) {
        this.appliedBitrateKbps = next;
        this.deps.capture.setBitrate?.(next);
        process.stderr.write(
          `[adapt] ${previous} -> ${next} kbps (encoder set) ` +
            `(${congested ? `standing backlog ${(standing / 1024).toFixed(0)}KB (peak ${(peak / 1024).toFixed(0)}KB), ${drops} dropped` : "link healthy"})\n`,
        );
      }

      // The strip reports the target, which now moves on every tick; the
      // measurement timer sends the rest.
      if (next !== previous) this.sendQualityState();
    }, ADAPT_INTERVAL_MS);
    this.adaptTimer.unref?.();
  }

  /**
   * Reports what the stream is actually costing, every REPORT_INTERVAL_MS.
   *
   * Deliberately separate from the adaptive controller. Measuring is not
   * adapting: the controller only runs on engines that expose setBitrate, and
   * folding the measurement into its tick left the MJPEG and screenshot paths
   * with no rate to show at all. It also reported only when the target moved,
   * so the number froze for as long as the controller had nothing to do —
   * while the real cost kept changing with whatever was on screen.
   */
  private startMeasuring(): void {
    if (this.measureTimer) return;
    // Opened here rather than at construction: an agent that sat idle before a
    // viewer arrived would otherwise divide the first window's bytes by that
    // whole idle period and open on a rate a fraction of the truth.
    this.sentBytes = 0;
    this.measureWindowAt = Date.now();
    this.measureTimer = setInterval(() => {
      const elapsedMs = Date.now() - this.measureWindowAt;
      if (elapsedMs <= 0) return;
      this.measuredKbps = Math.round((this.sentBytes * 8) / elapsedMs);
      this.sentBytes = 0;
      this.measureWindowAt = Date.now();
      this.sendQualityState();
    }, REPORT_INTERVAL_MS);
    this.measureTimer.unref?.();
  }

  private stopMeasuring(): void {
    if (this.measureTimer) {
      clearInterval(this.measureTimer);
      this.measureTimer = null;
    }
  }

  /** Applies the current ladder rung to the encoder and says why. */
  private applyRung(reason: string): void {
    const rung = this.getLadder()[this.ladderRung];
    this.deps.capture.setScale?.(rung.width, rung.fps);
    process.stderr.write(
      `[adapt] quality -> ${rung.width}px @ ${rung.fps}fps (${reason})\n`,
    );
    this.sendQualityState();
  }

  /**
   * Tells the viewer what it is actually being shown.
   *
   * A stepped-down picture is otherwise silent: the image just gets soft, with
   * nothing to distinguish adaptation from a stalled encoder or a bad link.
   */
  /**
   * Applies the viewer's resolution choice. `width === null` returns control to
   * the adaptive controller from wherever it currently is.
   */
  private applyQualityChoice(width: number | null, fps?: number): void {
    if (width === null) {
      this.qualityMode = "auto";
      this.pinned = null;
      this.setBuffering(false);
      // Resume the rung the ladder was on BEFORE the pin, not the rung matching
      // the pinned width. Pinning 1920 on a weak link left encodeWidth at 1920,
      // so the old nearestRung() lookup returned rung 0 and un-pinning snapped
      // straight back to full quality -- with bitrate still parked at the floor
      // from the pinned period, which immediately walked the ladder to the
      // bottom. Falls back to the nearest rung when nothing was recorded.
      this.ladderRung =
        this.rungBeforePin ?? this.nearestRung(this.deps.capture.encodeWidth ?? 0);
      this.rungBeforePin = null;
      // The pinned period tells us nothing about this rung's sustainability.
      this.healthyChecks = 0;
      this.floorChecks = 0;
      this.applyRung("viewer returned quality to auto");
      return;
    }

    const ladder = this.getLadder();
    // Snap to a real rung so the picker can never ask for a geometry the
    // encoder would silently clamp anyway (see H264Capture.setScale).
    const choice = ladder[this.nearestRung(width)] ?? ladder[0];
    if (this.qualityMode === "auto") this.rungBeforePin = this.ladderRung;
    this.qualityMode = "manual";
    this.pinned = { width: choice.width, fps: fps ?? choice.fps };
    this.healthyChecks = 0;
    this.floorChecks = 0;
    this.deps.capture.setScale?.(this.pinned.width, this.pinned.fps);
    process.stderr.write(
      `[adapt] quality pinned -> ${this.pinned.width}px @ ${this.pinned.fps}fps (viewer choice)\n`,
    );
    this.sendQualityState();
  }

  /** Index of the ladder rung closest to `width`. */
  private nearestRung(width: number): number {
    const ladder = this.getLadder();
    let best = 0;
    for (let i = 1; i < ladder.length; i++) {
      if (Math.abs(ladder[i].width - width) < Math.abs(ladder[best].width - width)) best = i;
    }
    return best;
  }

  /**
   * Puts one paced frame on whichever transport is carrying video.
   *
   * The transport is chosen at RELEASE time rather than at enqueue time: a
   * frame may wait a few tens of milliseconds in the pacer, and a QUIC session
   * can attach or die inside that window.
   */
  private sendPaced(frame: Uint8Array): void {
    const ws = this.controller;
    if (!ws || ws.readyState !== ws.OPEN) return;
    // Counted once here rather than per transport: the same envelope goes over
    // whichever one carries it, including the fallback below.
    this.sentBytes += frame.byteLength;

    const wt = this.deps.webtransport;
    if (wt?.hasSession) {
      void wt.send(frame).then((sent) => {
        // Nobody actually took it (session died between the check and the
        // write): fall back rather than silently dropping the frame.
        if (!sent && ws.readyState === ws.OPEN) ws.send(frame, { binary: true });
      });
      return;
    }
    ws.send(frame, { binary: true });
  }

  /** Reports a buffering transition once, rather than on every frame. */
  private setBuffering(active: boolean): void {
    if (this.buffering === active) return;
    this.buffering = active;
    this.sendQualityState();
  }

  private sendQualityState(ws: WebSocket | null = this.controller): void {
    if (!ws) return;
    const ladder = this.getLadder();
    const rung =
      this.pinned ??
      ladder[this.ladderRung] ?? {
        width: this.deps.capture.encodeWidth ?? 0,
        fps: this.deps.capture.encodeFps ?? 0,
      };
    if (!rung.width || !rung.fps) return; // engine exposes no scaling; nothing to report
    this.send(ws, {
      type: "qualityState",
      width: rung.width,
      fps: rung.fps,
      bitrateKbps: this.bitrateKbps,
      measuredKbps: this.measuredKbps,
      degraded: this.qualityMode === "auto" && this.ladderRung > 0,
      mode: this.qualityMode,
      buffering: this.buffering,
      options: ladder.map((r) => ({ width: r.width, fps: r.fps })),
    });
  }

  private stopAdapting(): void {
    this.stopMeasuring();
    if (this.adaptTimer) {
      clearInterval(this.adaptTimer);
      this.adaptTimer = null;
    }
    this.peakBacklog = 0;
    this.troughBacklog = null;
    this.dropsSinceAdapt = 0;
    this.ladderRung = 0;
    this.healthyChecks = 0;
    this.floorChecks = 0;
    this.rungBeforePin = null;
    // Rung 0 must mean full quality for the NEXT session too, so the encoder
    // has to actually be there — and the ladder is rebuilt from the baseline
    // rather than reused, in case the display changed between sessions.
    this.restoreBaselineQuality();
    this.ladder = null;
    // The next viewer has made no choice yet, so they get Auto.
    this.qualityMode = "auto";
    this.pinned = null;
    this.buffering = false;
  }

  /**
   * Reports sustained frame dropping, throttled.
   *
   * Dropping is the correct response to a saturated link, but silence about it
   * would be misleading: a user seeing a low frame rate deserves to know the
   * link is the limit rather than the capture. Throttled because under real
   * saturation this fires on nearly every captured frame.
   */
  private logDroppedFrames(bufferedAmount: number): void {
    const now = Date.now();
    if (now - this.lastDropLogAt < DROP_LOG_THROTTLE_MS) return;
    const dropped = this.droppedFrames;
    this.droppedFrames = 0;
    this.lastDropLogAt = now;
    process.stderr.write(
      `[capture] link saturated — dropped ${dropped} frame(s), ` +
        `${(bufferedAmount / 1024).toFixed(0)}KB still queued. ` +
        `Lower the frame rate or resolution for a smoother stream.\n`,
    );
  }

  private onConnection(ws: WebSocket): void {
    // Only one controller at a time.
    if (this.controller) {
      this.send(ws, { type: "authResult", ok: false, reason: "busy" });
      ws.close();
      return;
    }

    let authed = false;

    ws.on("message", (data, isBinary) => {
      if (isBinary) return; // client never sends binary frames
      let msg;
      try {
        msg = parseClientMessage(data.toString());
      } catch {
        this.send(ws, { type: "agentError", message: "malformed message" });
        return;
      }

      if (!authed) {
        if (msg.type !== "auth") {
          this.send(ws, { type: "authResult", ok: false, reason: "auth required" });
          ws.close();
          return;
        }
        if (!secretsMatch(msg.secret, this.deps.secret)) {
          this.send(ws, { type: "authResult", ok: false, reason: "invalid secret" });
          ws.close();
          return;
        }
        authed = true;
        this.controller = ws;
        void this.onAuthenticated(ws);
        return;
      }

      void this.onControlMessage(ws, msg);
    });

    ws.on("close", () => {
      if (this.controller === ws) {
        this.controller = null;
        this.autotyping = false;
        this.autotypeAbort?.abort(); // stop any in-progress autotype
        // The client is gone and cannot send the key-ups for anything it left
        // down. A modifier held past this point would corrupt every keystroke
        // the machine sees from now on, including its owner's.
        void this.deps.input.releaseAllKeys();
        this.deps.capture.stop();
        this.stopAdapting();
        this.deps.audio.stop();
        // Safety: never leave the agent's input locked with no controller.
        void this.deps.inputLock.unlock();
      }
    });

    ws.on("error", () => {
      /* handled by close */
    });
  }

  private async onAuthenticated(ws: WebSocket): Promise<void> {
    this.send(ws, { type: "authResult", ok: true });
    try {
      const { width, height } = await this.deps.input.screenSize();
      this.send(ws, {
        type: "agentInfo",
        screenWidth: width,
        screenHeight: height,
        nickname: this.deps.nickname,
        refreshHz: this.deps.refreshHz,
        // Sent only after auth: the certificate hash is what lets a client
        // open a QUIC session to a self-signed listener, so it goes to
        // clients that have already proved they know the secret.
        webtransport:
          this.deps.webtransport?.certHash != null
            ? { port: this.deps.webtransport.port, certHash: this.deps.webtransport.certHash }
            : undefined,
      });
    } catch (err) {
      this.send(ws, { type: "agentError", message: `screen size: ${String(err)}` });
    }

    // Tell the client whether input-lock is available and its current state.
    this.send(ws, {
      type: "inputLockState",
      locked: this.deps.inputLock.isLocked,
      supported: this.deps.inputLock.supported,
    });

    // Tell the client whether system-audio capture is available. Off by default;
    // the client turns it on when it wants to transcribe.
    this.send(ws, {
      type: "audioState",
      enabled: false,
      supported: this.deps.audio.supported,
    });

    // The machine's own output volume, so the client's slider starts where the
    // machine actually is rather than at an invented default.
    void this.sendVolumeState(ws);

    this.deps.capture.setInterval(SCREENSHOT_INTERVAL);
    this.startCapture();

    // Latch the untouched geometry before anything can scale it.
    this.rememberBaseline();

    // Baseline quality, so the indicator reads the true starting resolution
    // rather than staying blank until the first adaptation.
    this.sendQualityState(ws);
  }

  /**
   * (Re)starts the frame-capture loop with the standard forwarding callback.
   * `capture.start()` is safe to call again (it just restarts the pipeline),
   * so this can be called when capture is already running.
   */
  private startCapture(): void {
    this.startAdapting();
    this.startMeasuring();
    this.deps.capture.start((image) => {
      const ws = this.controller;
      if (ws?.readyState !== ws?.OPEN || !ws) return;

      // Drop rather than queue once the socket is already behind. Encoding is
      // skipped too, not just the send: a frame that would only be dropped is
      // not worth the JPEG encode. See MAX_QUEUED_FRAME_BYTES for why an
      // unbounded queue here made Classic drift permanently behind real time.
      const wtSend = this.deps.webtransport;
      // Deciding not to encode a frame the transport cannot take is a
      // legitimate local question, so the depth is still read here -- but a
      // depth that never changes is not a queue, and believing one stopped the
      // stream dead. See StuckBacklogDetector.
      const reported = wtSend?.hasSession ? wtSend.backlogBytes : ws.bufferedAmount;
      const believable = this.stuckBacklog.trust(reported);
      if (!believable && this.stuckBacklog.shouldReport()) {
        process.stderr.write(
          `[capture] transport backlog frozen at ${(reported / 1024).toFixed(0)}KB; ` +
            `ignoring it as stale rather than starving the stream\n`,
        );
      }
      // The pacer's own queue always counts. It sits in front of the transport,
      // so measuring only the transport would let the capture loop encode
      // happily into a backlog building one layer earlier.
      const queued = (believable ? reported : 0) + this.pacer.queuedBytes;
      if (queued > this.peakBacklog) this.peakBacklog = queued;
      if (this.troughBacklog === null || queued < this.troughBacklog) this.troughBacklog = queued;
      const dropAbove =
        this.deps.maxQueuedFrameBytes ??
        (this.qualityMode === "manual"
          ? BUFFERED_MAX_QUEUED_FRAME_BYTES
          : MAX_QUEUED_FRAME_BYTES);
      // Buffering is only meaningful against the real-time threshold: past it
      // an auto session would already be dropping, so this is the point where
      // a pinned session is knowingly trading latency for the chosen size.
      // Measured against `queued`, NOT ws.bufferedAmount: once a QUIC session
      // is attached the WebSocket carries only control messages and always
      // looks idle, so backpressure never engaged on the transport actually
      // carrying video. Frames queued in QUIC without limit while the log
      // cheerfully reported "0 dropped" against a 674KB backlog.
      this.setBuffering(this.qualityMode === "manual" && queued > MAX_QUEUED_FRAME_BYTES);
      if (queued > dropAbove) {
        this.droppedFrames++;
        this.dropsSinceAdapt++;
        this.logDroppedFrames(queued);
        return;
      }

      // `keyframe` matters only for H.264, where a delta frame is undecodable
      // without the keyframe it references. Intra-only formats (JPEG/PNG) leave
      // it undefined and default to true, since every such frame stands alone.
      const buf = encodeFrame(
        this.seq++,
        Date.now(),
        image.format,
        image.data,
        image.keyframe ?? true,
      );

      // Metered out rather than handed over whole; see FramePacer for why an
      // unpaced keyframe is indistinguishable, at the receiver, from the link
      // stalling. The pacer decides WHEN, not whether: it never discards.
      this.pacer.enqueue(new Uint8Array(buf));
    });
  }

  private async onControlMessage(
    ws: WebSocket,
    msg: ReturnType<typeof parseClientMessage>,
  ): Promise<void> {
    try {
      switch (msg.type) {
        case "setMode":
          // Capture may not be running yet on the first setMode; start it.
          this.startCapture();
          this.deps.capture.setInterval(msg.intervalMs);
          break;
        case "transportFeedback":
          for (const s of msg.samples) {
            // Ordered and de-duplicated here rather than in the estimator: it
            // measures queueing, and a replayed or out-of-order report says
            // nothing about that.
            if (s.seq <= this.lastFeedbackSeq) continue;
            this.lastFeedbackSeq = s.seq;
            this.trendline.add({ sendMs: s.sendMs, arrivalMs: s.arrivalMs });
            this.ackedRate.add({ seq: s.seq, arrivalMs: s.arrivalMs, bytes: s.bytes });
          }
          break;
        case "setQuality":
          this.applyQualityChoice(msg.width, msg.fps);
          break;
        case "mouse":
          this.deps.inputLock.noteClientActivity();
          if (this.autotyping) break; // see the "key" case below
          await this.deps.input.applyMouse(msg);
          break;
        case "key":
          this.deps.inputLock.noteClientActivity();
          // Drop remote input while a run is in progress. Messages are
          // dispatched fire-and-forget, so a stray keystroke from the client
          // interleaves with the typed text -- and a modifier landing between
          // two characters makes every character after it a shortcut until its
          // key-up arrives. Cancelling the run is the way to take back control;
          // "cancelAutotype" is handled below and is deliberately not gated.
          if (this.autotyping) break;
          await this.deps.input.applyKey(msg);
          break;
        case "autotype":
          this.deps.inputLock.noteClientActivity();
          await this.handleAutotype(ws, msg.text, msg.profile);
          break;
        case "cancelAutotype":
          this.autotypeAbort?.abort();
          break;
        case "setInputLock":
          await this.handleSetInputLock(ws, msg.locked);
          break;
        case "setAudio":
          this.handleSetAudio(ws, msg.enabled);
          break;
        case "setOutputVolume":
          await this.handleSetOutputVolume(msg.level);
          break;
        case "setOutputMute":
          await this.handleSetOutputMute(msg.muted);
          break;
        case "runDiagnostics":
          await this.handleRunDiagnostics(ws);
          break;
        case "getClipboard": {
          const text = await this.deps.clipboard.getContent();
          this.send(ws, { type: "clipboardContent", text });
          break;
        }
        case "setClipboard":
          await this.deps.clipboard.setContent(msg.text);
          break;
        case "auth":
          break; // already authenticated; ignore duplicate
      }
    } catch (err) {
      this.send(ws, { type: "agentError", message: String(err) });
    }
  }

  private async handleRunDiagnostics(ws: WebSocket): Promise<void> {
    let screenSize: { width: number; height: number } | null = null;
    try {
      screenSize = await this.deps.input.screenSize();
    } catch {
      screenSize = null; // reported as a failed check
    }
    // Read the live volume rather than a cached value: the point of the panel
    // is to report what is true now, and anyone at the machine can change it.
    const volumeNow = this.deps.volume.supported ? await this.deps.volume.get() : null;
    const checks = runDiagnostics({
      outputVolume: volumeNow
        ? { supported: true, level: volumeNow.level, muted: volumeNow.muted }
        : { supported: false, level: 0, muted: false },
      refreshHz: this.deps.refreshHz,
      captureKind: this.deps.captureKind,
      videoEncoder: this.deps.capture.activeEncoder ?? null,
      videoWidth: this.deps.capture.encodeWidth ?? null,
      videoFps: this.deps.capture.encodeFps ?? null,
      webtransportPort: this.deps.webtransport?.certHash ? this.deps.webtransport.port : null,
      inputLockSupported: this.deps.inputLock.supported,
      audioSupported: this.deps.audio.supported,
      screenSize,
    });
    this.send(ws, { type: "diagnostics", checks });
  }

  private async handleSetInputLock(ws: WebSocket, locked: boolean): Promise<void> {
    if (locked && !this.deps.inputLock.supported) {
      this.send(ws, {
        type: "agentError",
        message: "local input lock is not supported on this agent's OS yet",
      });
      this.send(ws, { type: "inputLockState", locked: false, supported: false });
      return;
    }
    try {
      if (locked) await this.deps.inputLock.lock();
      else await this.deps.inputLock.unlock();
    } catch (err) {
      // Engaging the lock failed (e.g. Windows BlockInput refused because the
      // agent isn't elevated). Report the reason AND the true state, so the
      // client never shows a lock that isn't actually holding.
      this.send(ws, { type: "agentError", message: String(err) });
      this.send(ws, {
        type: "inputLockState",
        locked: this.deps.inputLock.isLocked,
        supported: this.deps.inputLock.supported,
      });
      return;
    }
    // State is also broadcast via notifyLockState (manager onChange), but reply
    // here too so a no-op request still gets an authoritative answer.
    this.send(ws, {
      type: "inputLockState",
      locked: this.deps.inputLock.isLocked,
      supported: this.deps.inputLock.supported,
    });
  }

  /**
   * Start or stop streaming system-audio (loopback) frames to the controller.
   * If capture isn't supported, reports that honestly instead of a silent no-op.
   */
  /**
   * Applies a volume change, then reports what the machine actually ended up
   * at rather than echoing what was asked for.
   *
   * The two can differ: the OS clamps, quantises to its own step size, and may
   * refuse outright. Echoing the request would leave the client's slider
   * showing a value the machine is not at, and the disagreement would persist
   * until something else refreshed it.
   */
  private async handleSetOutputVolume(level: number): Promise<void> {
    await this.volumeApplier.set(level);
    // Only once the burst has drained: a read-back per position would double
    // the per-change cost for values nobody will see, and the state that
    // matters is where the machine ended up.
    if (!this.volumeApplier.busy) await this.sendVolumeState();
  }

  private async handleSetOutputMute(muted: boolean): Promise<void> {
    await this.deps.volume.setMuted(muted);
    await this.sendVolumeState();
  }

  /** Tell the connected client the machine's current output volume. */
  private async sendVolumeState(ws: WebSocket | null = this.controller): Promise<void> {
    if (!ws) return;
    const supported = this.deps.volume.supported;
    const current = supported ? await this.deps.volume.get() : null;
    this.send(ws, {
      type: "outputVolumeState",
      // A controller that cannot read the level cannot report one honestly,
      // so it is reported unsupported even where the platform is implemented.
      supported: supported && current !== null,
      level: current?.level ?? 0,
      muted: current?.muted ?? false,
    });
  }

  private handleSetAudio(ws: WebSocket, enabled: boolean): void {
    if (enabled && !this.deps.audio.supported) {
      this.send(ws, {
        type: "agentError",
        message:
          "system-audio capture unavailable: no loopback device (install BlackHole/VB-Cable, see README)",
      });
      this.send(ws, { type: "audioState", enabled: false, supported: false });
      return;
    }
    if (enabled) {
      this.audioSeq = 0;
      this.deps.audio.start((pcm) => {
        if (this.controller?.readyState === this.controller?.OPEN) {
          const buf = encodeAudioFrame(
            this.audioSeq++,
            Date.now(),
            this.deps.audio.sampleRate,
            this.deps.audio.channels,
            AudioFormat.PCM_S16LE,
            pcm,
          );
          this.controller!.send(buf, { binary: true });
        }
      });
    } else {
      this.deps.audio.stop();
    }
    this.send(ws, {
      type: "audioState",
      enabled,
      supported: this.deps.audio.supported,
    });
  }

  /** Push the current lock state to the connected controller, if any. */
  notifyLockState(locked: boolean): void {
    if (this.controller) {
      this.send(this.controller, {
        type: "inputLockState",
        locked,
        supported: this.deps.inputLock.supported,
      });
    }
  }

  private async handleAutotype(
    ws: WebSocket,
    text: string,
    profile: AutotypeProfile,
  ): Promise<void> {
    if (this.autotyping) {
      this.send(ws, { type: "agentError", message: "autotype already running" });
      return;
    }
    this.autotyping = true;
    const abort = new AbortController();
    this.autotypeAbort = abort;
    try {
      // Start clean: a modifier the client left down would turn the whole run
      // into a stream of shortcuts.
      const stale = await this.deps.input.releaseAllKeys();
      if (stale > 0) {
        process.stderr.write(`[autotype] released ${stale} stale key(s) before typing\n`);
      }
      const completed = await runAutotype(
        text,
        profile,
        { backend: this.deps.typingBackend, signal: abort.signal },
        { onProgress: (done, total) => this.send(ws, { type: "autotypeProgress", done, total }) },
      );
      this.send(ws, { type: "autotypeDone", cancelled: !completed });
    } finally {
      this.autotyping = false;
      this.autotypeAbort = null;
      await this.deps.input.releaseAllKeys().catch(() => {});
    }
  }
}
