/**
 * Tracks bytes handed to QUIC but not yet flushed, per session.
 *
 * ## Why this is not a single counter
 *
 * It was, and the counter leaked. Bytes were added before a write and removed
 * in its `finally`, which is correct only if the write always settles. A write
 * to a session whose client has gone away may never settle at all: the promise
 * is simply never resolved or rejected, the `finally` never runs, and those
 * bytes are counted as in-flight for the rest of the process's life.
 *
 * Nothing about that is subtle in its effects. The controller reads this number
 * as its congestion signal and the capture loop reads it as backpressure, so a
 * few hundred stranded kilobytes are indistinguishable from a link that is
 * permanently behind. Observed on Windows after a handful of reconnects: the
 * backlog sat at exactly 633KB and then exactly 734KB -- never moving, which no
 * real queue does -- while every frame was dropped as undeliverable and the
 * quality ladder walked from 1920p to 320p on a link with nothing wrong with
 * it. Each reconnect added another session's worth and none was ever returned.
 *
 * Keeping the count per session makes the leak unrepresentable: when a session
 * ends its account goes with it, whatever its outstanding writes are doing.
 * Those writes may settle later, or never; either way they are settling against
 * an account nobody is reading.
 */
export class SessionBacklog {
  private readonly accounts = new Map<object, { bytes: number }>();

  /** Starts counting for a session. */
  open(session: object): void {
    if (!this.accounts.has(session)) this.accounts.set(session, { bytes: 0 });
  }

  /**
   * Stops counting for a session, discarding whatever it still had outstanding.
   *
   * This is the whole point: a dead session's unsettled writes must stop being
   * read as a live queue.
   */
  close(session: object): void {
    this.accounts.delete(session);
  }

  /** Bytes outstanding across every live session. */
  get bytes(): number {
    let total = 0;
    for (const account of this.accounts.values()) total += account.bytes;
    return total;
  }

  /** Live session count, so callers need not track it separately. */
  get sessionCount(): number {
    return this.accounts.size;
  }

  /**
   * Records `bytes` as outstanding for `session` and returns the function that
   * settles them.
   *
   * Returning the settle function rather than exposing add/remove keeps the two
   * halves together, and makes settling a session that has since closed a
   * no-op instead of an error or a negative balance.
   */
  begin(session: object, bytes: number): () => void {
    const account = this.accounts.get(session);
    if (!account) return () => {};
    account.bytes += bytes;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      // Re-read: the session may have closed and been reopened in between, and
      // this belongs to neither.
      if (this.accounts.get(session) === account) account.bytes -= bytes;
    };
  }
}
