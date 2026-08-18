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
  /** The frame's sequence number, so a subset can be asked about later. */
  seq: number;
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

  /**
   * Rate over a specific run of frames, rather than over the trailing window.
   *
   * A probe lasts a fraction of an adaptation interval, so asking the ordinary
   * window what it carried averages the probe together with the quiet traffic
   * around it and buries the answer -- measured, every probe was diluted past
   * its success threshold and none ever returned a verdict.
   *
   * Identified by sequence number rather than by time because the timestamps
   * here are the CLIENT's, and the agent has no way to say when its own probe
   * began in the client's clock. Sequence numbers need no such translation.
   */
  rateForSeqRange(fromSeq: number, toSeq: number): number | null {
    const inRange = this.samples.filter((s) => s.seq >= fromSeq && s.seq <= toSeq);
    if (inRange.length < 2) return null;
    let oldest = Infinity;
    let newest = -Infinity;
    let bytes = 0;
    let firstBytes = 0;
    for (const s of inRange) {
      if (s.arrivalMs < oldest) {
        oldest = s.arrivalMs;
        firstBytes = s.bytes;
      }
      if (s.arrivalMs > newest) newest = s.arrivalMs;
      bytes += s.bytes;
    }
    const span = newest - oldest;
    if (span <= 0) return null;
    // As above: the opening sample marks where the span starts and so does not
    // belong to the bytes carried across it.
    return Math.round(((bytes - firstBytes) * 8) / span);
  }

  reset(): void {
    this.samples = [];
  }
}
