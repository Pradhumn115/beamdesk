/**
 * Notices a transport backlog that has stopped being a measurement.
 *
 * Backpressure is a legitimate local question -- there is no point encoding a
 * frame the transport cannot take -- so the queue depth is still read for that.
 * But it is local state, and local state can be wrong in ways a network
 * measurement cannot: a stranded write left bytes counted as outstanding
 * forever, and every frame was then skipped as undeliverable while the link sat
 * idle. The leak that caused it is fixed at its source (see SessionBacklog),
 * and this exists so that the next one of its kind cannot wedge the stream.
 *
 * The signature is unmistakable. A live queue changes constantly -- bytes
 * arrive, bytes drain -- so the same non-zero depth, to the byte, tick after
 * tick, is not a queue. Observed at exactly 633KB and then exactly 734KB across
 * an entire session.
 *
 * Zero is exempt: an idle transport genuinely reports nothing outstanding, and
 * that answer blocks nothing anyway.
 */

/**
 * Identical readings before the depth is distrusted.
 *
 * At one reading per frame this is a fraction of a second of traffic, which no
 * real queue survives unchanged; the risk of mistaking a real queue for a leak
 * is therefore negligible in the direction that matters.
 */
const STUCK_READINGS = 90;

export class StuckBacklogDetector {
  private lastBytes: number | null = null;
  private repeats = 0;
  private reported = false;

  /**
   * Records one reading and says whether the depth can still be believed.
   *
   * Returns true while the value looks like a live queue, false once it has
   * been identical and non-zero for long enough that it cannot be.
   */
  trust(bytes: number): boolean {
    if (bytes !== this.lastBytes) {
      this.lastBytes = bytes;
      this.repeats = 0;
      this.reported = false;
      return true;
    }
    if (bytes === 0) return true;
    this.repeats++;
    return this.repeats < STUCK_READINGS;
  }

  /**
   * True exactly once per stuck episode, so the caller can log it without
   * repeating itself on every frame.
   */
  shouldReport(): boolean {
    if (this.reported || this.repeats < STUCK_READINGS) return false;
    this.reported = true;
    return true;
  }

  reset(): void {
    this.lastBytes = null;
    this.repeats = 0;
    this.reported = false;
  }
}
