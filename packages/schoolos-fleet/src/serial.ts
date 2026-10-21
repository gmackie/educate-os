/**
 * Runs asynchronous steps one at a time, in the order they were queued. A Durable Object delivers
 * a new request whenever the current one awaits, so a read-modify-write that awaits between its
 * read and its write (verifying a signature, say) would otherwise interleave with another and lose
 * an update. The releases manager and controller and the commerce stores queue their steps here.
 */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();

  /** Runs `step` after every step queued before it has settled, and returns its result. */
  run<T>(step: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(step);
    // A failed step must not stop the ones queued after it.
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
