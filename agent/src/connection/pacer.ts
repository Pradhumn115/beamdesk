/**
 * Meters frames onto the wire instead of handing them over in bursts.
 *
 * ## The problem
 *
 * An encoder emits a frame all at once, and this agent passed it straight to
 * the transport. A keyframe is tens of times larger than the delta frames
 * around it, so the link receives a spike it never asked for: at 30fps the
 * bytes for one GOP boundary arrive in the space of one frame interval rather
 * than spread over the interval they were budgeted for.
 *
 * That spike is indistinguishable, at the receiver, from the link briefly
 * failing to keep up -- which is exactly the false positive that drove the
 * whole session's worth of bugs here. It filled the send queue, tripped a
 * congestion detector reading queue depth, and made the delay gradient jump
 * for the frames behind it. Smoothing it at the source removes the cause
 * rather than teaching each detector to forgive it.
 *
 * ## Why pacing does not add latency here
 *
 * Released at exactly the target bitrate, a frame larger than its share would
 * wait -- and waiting is precisely what a remote-control session cannot afford.
 * So the bucket refills at a MULTIPLE of the target, as WebRTC's pacer does.
 * The burst is still flattened, because a keyframe is far more than 2.5 frames'
 * worth of bytes, but ordinary frames never wait at all: their budget is
 * already there when they arrive.
 *
 * ## Backpressure, not dropping
 *
 * This class never discards. A queued H.264 delta frame cannot be dropped
 * without corrupting everything up to the next keyframe, and the decision about
 * what to skip belongs upstream, before the encode -- see the capture callback,
 * which already declines to encode frames the link cannot take. It reads
 * `queuedBytes` from here so that a filling pacer applies the same
 * backpressure a filling socket does.
 */

/** Refill rate as a multiple of the target bitrate. WebRTC's default is 2.5. */
const PACING_FACTOR = 2.5;

/**
 * Largest credit the bucket may bank while idle.
 *
 * Without a cap, a still screen accumulates budget for as long as it stays
 * still and then releases the entire backlog at once the moment it moves --
 * reinventing the burst this exists to prevent. One frame interval's worth at
 * the pacing rate is enough to keep ordinary frames from ever waiting.
 */
const MAX_BURST_MS = 40;

/**
 * Longest the queue may represent, in milliseconds of release at the current
 * rate. Past this, frames go out unpaced.
 *
 * Smoothing is worth a few tens of milliseconds and nothing like a few hundred.
 * This is a remote-control session: a queue of video is a queue of stale
 * pictures, and a cursor that answers half a second late is worse than any
 * burst. Measured without this bound the pacer held 470KB -- about half a
 * second of video -- after each keyframe on a link with capacity to spare.
 *
 * Releasing early does not undo the pacer's purpose. It means the link is being
 * offered more than the target can smooth, which is a bitrate problem, and the
 * controller is already the thing that answers it.
 */
const MAX_QUEUE_MS = 120;

export interface PacerDeps {
  /** Hands one frame to the transport. */
  send(frame: Uint8Array): void;
  /** Injectable for tests; defaults to the wall clock. */
  now?: () => number;
  /** Injectable for tests; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
}

export class FramePacer {
  private queue: Uint8Array[] = [];
  private queued = 0;
  private budgetBytes = 0;
  private lastRefillMs: number;
  private timerPending = false;
  /** Bytes per millisecond the bucket refills at; set from the target bitrate. */
  private rateBytesPerMs = (2500 * PACING_FACTOR) / 8;

  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => void;

  constructor(private readonly deps: PacerDeps) {
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.lastRefillMs = this.now();
  }

  /** Bytes waiting to go out; read as backpressure by the capture loop. */
  get queuedBytes(): number {
    return this.queued;
  }

  /** Follows the adaptive controller's target. */
  setTargetKbps(kbps: number): void {
    // kbit/s -> bytes/ms is a straight divide by 8.
    this.rateBytesPerMs = Math.max(1, (kbps * PACING_FACTOR) / 8);
  }

  enqueue(frame: Uint8Array): void {
    this.queue.push(frame);
    this.queued += frame.byteLength;
    this.drain();
  }

  /** Discards anything still waiting; the session it belonged to is over. */
  reset(): void {
    this.queue = [];
    this.queued = 0;
    this.budgetBytes = 0;
    this.lastRefillMs = this.now();
  }

  private refill(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefillMs);
    this.lastRefillMs = now;
    this.budgetBytes = Math.min(
      this.budgetBytes + elapsed * this.rateBytesPerMs,
      MAX_BURST_MS * this.rateBytesPerMs,
    );
  }

  private drain(): void {
    this.refill();
    while (this.queue.length > 0) {
      const head = this.queue[0];
      // A frame larger than the bucket can ever hold would wait forever against
      // its own size, so it asks only for a FULL bucket and then overdraws. The
      // debt is carried into the budget, which is what makes the frames behind
      // it wait -- spreading one oversized keyframe across the interval that
      // follows, rather than letting it past unpaced.
      //
      // Exempting such frames outright was the first attempt and was worse than
      // no pacer on a slow link: at 400kbit/s the bucket holds 5KB, so every
      // frame counted as oversized and nothing was paced at all -- precisely
      // the link where bursts hurt most.
      const cap = MAX_BURST_MS * this.rateBytesPerMs;
      // Holding more than MAX_QUEUE_MS of video costs more in staleness than
      // the smoothing is worth, so the backlog goes out rather than waiting.
      const overdue = this.queued > MAX_QUEUE_MS * this.rateBytesPerMs;
      if (!overdue && this.budgetBytes < Math.min(head.byteLength, cap)) break;
      this.queue.shift();
      this.queued -= head.byteLength;
      this.budgetBytes -= head.byteLength;
      this.deps.send(head);
    }
    if (this.queue.length > 0) this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.timerPending) return;
    const shortfall = this.queue[0].byteLength - this.budgetBytes;
    const waitMs = Math.max(1, Math.ceil(shortfall / this.rateBytesPerMs));
    this.timerPending = true;
    this.schedule(() => {
      this.timerPending = false;
      this.drain();
    }, waitMs);
  }
}
