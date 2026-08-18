/**
 * Delay-gradient congestion detection, as WebRTC's GCC does it.
 *
 * ## Why this exists alongside the queue-depth detector
 *
 * The shipped controller reads OUR OWN send queue: it calls the link congested
 * once bytes pile up locally. That is a lagging indicator. A queue only grows
 * after the bottleneck is already saturated, so by the time it fires the viewer
 * has been suffering for a while — and it says nothing at all about a link whose
 * bottleneck buffers on someone else's behalf.
 *
 * The delay GRADIENT leads instead of lags. When a bottleneck starts filling,
 * each packet waits slightly longer than the last, so the one-way delay rises
 * steadily while the queue is still building and before anything is lost. That
 * trend is visible well before our own socket notices.
 *
 * ## Clocks do not need to be synchronised
 *
 * The estimator never uses an absolute one-way delay, only how it CHANGES
 * between consecutive frames:
 *
 *     d_i = (arrival_i - arrival_i-1) - (send_i - send_i-1)
 *
 * Any fixed offset between the two machines' clocks appears in both bracketed
 * terms and cancels. Only relative clock DRIFT would survive, and over the
 * seconds-long window used here that is far below the noise.
 *
 * ## Method
 *
 * Accumulate d_i into a running total, smooth it, and fit a straight line to the
 * last WINDOW samples by least squares. The slope is the signal: positive means
 * queues are filling, zero means steady state, negative means they are draining.
 * The comparison threshold adapts — it rises while the trend is over it and
 * falls while under — which is what stops a permanently-loaded link from being
 * declared permanently congested.
 *
 * Constants follow WebRTC's TrendlineEstimator; see
 * modules/congestion_controller/goog_cc/trendline_estimator.cc.
 */

/** One frame's send and arrival times, in each machine's own clock. */
export interface ArrivalSample {
  sendMs: number;
  arrivalMs: number;
}

export type DelayVerdict = "normal" | "overusing" | "underusing";

/** Samples per regression window. WebRTC uses 20. */
const WINDOW = 20;
/** Exponential smoothing applied to accumulated delay before the fit. */
const SMOOTHING = 0.9;
/** Scales the slope before comparing it to the threshold. */
const THRESHOLD_GAIN = 4;
/** Sample count the modified trend saturates at, so a long window cannot dominate. */
const MAX_TREND_SAMPLES = 60;
/**
 * Consecutive over-threshold observations required before calling it congestion.
 *
 * Raising this to 3 was tried against a link with 80ms of delay and +/-20ms of
 * jitter, which produces spurious congestion on roughly one tick in twenty, and
 * made no measurable difference: spurious calls stayed at 5-6 per 54 ticks
 * either way. Samples arrive per frame, so three of them is barely 100ms, and
 * jitter of that size sustains a fake trend for far longer than that. Damping it
 * would take a much longer confirmation or a higher THRESHOLD_MIN, and both
 * trade away the responsiveness that makes this detector worth having.
 *
 * Left at 2 because nothing measured justified moving it. Recorded here so the
 * experiment is not repeated blind.
 */
const OVERUSE_CONFIRM = 2;

/** Adaptive threshold bounds and rates, from WebRTC's overuse detector. */
const THRESHOLD_INITIAL = 12.5;
const THRESHOLD_MIN = 6;
const THRESHOLD_MAX = 600;
const K_UP = 0.0087;
const K_DOWN = 0.039;

export class TrendlineEstimator {
  /** (arrivalMs, smoothed accumulated delay) pairs, newest last. */
  private readonly window: Array<{ t: number; acc: number }> = [];
  private accumulated = 0;
  private smoothed = 0;
  private previous: ArrivalSample | null = null;
  private threshold = THRESHOLD_INITIAL;
  private lastUpdateMs: number | null = null;
  private overuseRun = 0;
  private verdict: DelayVerdict = "normal";
  /** Most recent slope, exposed for logging while this runs in the shadow. */
  private trend = 0;

  /**
   * Feeds one frame's timing. Samples MUST arrive in send order; a frame that
   * overtakes another says nothing useful about queueing and is dropped.
   */
  add(sample: ArrivalSample): void {
    const prev = this.previous;
    this.previous = sample;
    if (!prev) return;

    const sendDelta = sample.sendMs - prev.sendMs;
    const arrivalDelta = sample.arrivalMs - prev.arrivalMs;
    // Reordered or duplicated: no queueing information, and a negative send
    // delta would invert the sign of the gradient.
    if (sendDelta <= 0) return;

    this.accumulated += arrivalDelta - sendDelta;
    this.smoothed = SMOOTHING * this.smoothed + (1 - SMOOTHING) * this.accumulated;
    this.window.push({ t: sample.arrivalMs, acc: this.smoothed });
    if (this.window.length > WINDOW) this.window.shift();
    if (this.window.length < WINDOW) return;

    this.trend = slope(this.window);
    this.classify(sample.arrivalMs);
  }

  /** The current reading, or "normal" until a full window has been seen. */
  current(): DelayVerdict {
    return this.verdict;
  }

  /** Slope and threshold, for side-by-side logging against the queue detector. */
  detail(): { trend: number; threshold: number; samples: number } {
    return { trend: this.trend, threshold: this.threshold, samples: this.window.length };
  }

  reset(): void {
    this.window.length = 0;
    this.accumulated = 0;
    this.smoothed = 0;
    this.previous = null;
    this.threshold = THRESHOLD_INITIAL;
    this.lastUpdateMs = null;
    this.overuseRun = 0;
    this.verdict = "normal";
    this.trend = 0;
  }

  private classify(nowMs: number): void {
    const modified = Math.min(this.window.length, MAX_TREND_SAMPLES) * this.trend * THRESHOLD_GAIN;

    if (modified > this.threshold) {
      // Confirmed over several samples: a single frame arriving late is jitter,
      // not congestion, and reacting to it would make the controller twitch.
      this.overuseRun++;
      if (this.overuseRun >= OVERUSE_CONFIRM) this.verdict = "overusing";
    } else {
      this.overuseRun = 0;
      this.verdict = modified < -this.threshold ? "underusing" : "normal";
    }

    this.adaptThreshold(modified, nowMs);
  }

  /**
   * Moves the threshold toward the observed trend.
   *
   * Without this, any link with a standing queue reads as permanently congested
   * and the controller can never climb back — the same shape of bug as reading a
   * keyframe burst as a standing queue. Rising is deliberately much slower than
   * falling (K_UP << K_DOWN) so a genuine sustained overuse still registers.
   */
  private adaptThreshold(modified: number, nowMs: number): void {
    const magnitude = Math.abs(modified);
    // Far outside the band the sample says nothing about where the boundary
    // should sit; adapting to it would chase an outlier.
    if (magnitude > this.threshold + 15) {
      this.lastUpdateMs = nowMs;
      return;
    }
    const elapsed = this.lastUpdateMs === null ? 0 : Math.min(nowMs - this.lastUpdateMs, 100);
    this.lastUpdateMs = nowMs;
    const k = magnitude < this.threshold ? K_DOWN : K_UP;
    this.threshold += k * (magnitude - this.threshold) * elapsed;
    this.threshold = Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, this.threshold));
  }
}

/** Least-squares slope of `acc` against `t`. Zero when t never varies. */
function slope(points: ReadonlyArray<{ t: number; acc: number }>): number {
  let sumT = 0;
  let sumAcc = 0;
  for (const p of points) {
    sumT += p.t;
    sumAcc += p.acc;
  }
  const meanT = sumT / points.length;
  const meanAcc = sumAcc / points.length;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - meanT) * (p.acc - meanAcc);
    den += (p.t - meanT) ** 2;
  }
  return den === 0 ? 0 : num / den;
}
