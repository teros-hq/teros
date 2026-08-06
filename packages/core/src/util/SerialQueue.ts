/**
 * SerialQueue — single-writer FIFO. A thrown operation propagates only
 * to its own caller and does not block subsequent operations.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  add<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    // Tail advances regardless of outcome so one rejection doesn't poison
    // the queue.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
