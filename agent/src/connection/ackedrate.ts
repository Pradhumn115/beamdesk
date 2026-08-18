/**
 * The rate the receiver actually got, computed from its own arrival reports.
 *
 * ## Why the sender's own count is not good enough
 *
 * The agent already measures what it hands to a transport, and that number is
 * right for the status strip — it is what the encoder produced. It is the wrong
 * number to bound the bitrate target with, because the sender can keep pushing
 * bytes into a buffer whose far side is the real bottleneck. Measured on a
 * simulated link: the agent counted ~15Mbit/s leaving while the link delivered
 * 800kbit/s, and everything in between sat in a queue. Anchoring the target to
 * that number anchors it to a fiction.
 *
 * What arrived is the only claim the network cannot inflate, which is why
 * WebRTC's congestion control bounds its estimate by the ACKED rate rather than
 * the sent rate.
 *
 * ## Clocks
 *
 * Arrival timestamps come from the client's clock and are only ever subtracted
 * from each other, so no agreement with the agent's clock is needed or assumed.
 */

/** One reported arrival: when the client got it, and how big it was. */
export interface AckedSample {
  arrivalMs: number;
  bytes: number;
}

/**
 * Samples older than this (by the client's own clock) stop counting.
 *
 * Long enough to smooth over a keyframe landing inside it, short enough to
 * follow a link that changes. Matches the adaptation interval.
 */
const WINDOW_MS = 2000;

/**
 * Shortest span that yields a rate at all.
 *
 * Dividing by a very short span turns one frame into an enormous apparent rate,
 * and a single burst must never be read as sustained capacity.
 */
const MIN_SPAN_MS = 400;

export class AckedRateTracker {
  private samples: AckedSample[] = [];

  /** Adds one arrival report. Samples may arrive in any order. */
  add(sample: AckedSample): void {
    this.samples.push(sample);
  }

  /**
   * Rate over the trailing window in kbit/s, or null when too little has been
   * reported to say anything honest.
   */
  rateKbps(): number | null {
    if (this.samples.length < 2) return null;
    let newest = -Infinity;
    for (const s of this.samples) if (s.arrivalMs > newest) newest = s.arrivalMs;

    const cutoff = newest - WINDOW_MS;
    this.samples = this.samples.filter((s) => s.arrivalMs >= cutoff);
    if (this.samples.length < 2) return null;

    let oldest = Infinity;
    let bytes = 0;
    for (const s of this.samples) {
      if (s.arrivalMs < oldest) oldest = s.arrivalMs;
      bytes += s.bytes;
    }
    const span = newest - oldest;
    if (span < MIN_SPAN_MS) return null;

    // The first sample marks where the window opens rather than contributing a
    // duration, so its bytes do not belong to the span they precede. Counting
    // them overstates the rate by a whole frame every window.
    const counted = bytes - (this.samples.find((s) => s.arrivalMs === oldest)?.bytes ?? 0);
    return Math.round((counted * 8) / span);
  }

  reset(): void {
    this.samples = [];
  }
}
