/**
 * Pure retry helper with exponential backoff.
 *
 * Extracted from `UsageEventBuffer.flushBatchWithRetry` (R1 step 3 of the
 * refactor plan). Generic over the operation result type and free of any
 * coupling to events/queues — usable for any "attempt N times, backoff,
 * report exhausted" pattern.
 *
 * Semantics:
 *   - Runs `fn` up to `maxAttempts` times.
 *   - Between attempts, sleeps `baseDelayMs * 2^(attempt-1)` (i.e. base,
 *     base×2, base×4, …) so the caller can match the same schedule the
 *     buffer had before this extraction.
 *   - Reports per-attempt failure via the optional `onAttemptFail` hook
 *     (used by the buffer to bump its `events_retried` counter).
 *   - Returns a discriminated union; callers handle exhaustion explicitly
 *     instead of catching an exception.
 *
 *
 */

export interface RetryOptions {
  /** Total attempts before giving up. The first call counts as attempt 1. */
  maxAttempts: number
  /** Base delay; attempt N waits `baseDelayMs * 2^(N-1)` before retrying. */
  baseDelayMs: number
  /**
   * Invoked synchronously after every failed attempt. Receives the error
   * and the (1-indexed) attempt number that just failed. Useful for
   * counters/logging without coupling the helper to a specific reporter.
   */
  onAttemptFail?: (err: unknown, attempt: number) => void
  /**
   * Sleep function. Defaults to `setTimeout`-based. Injectable for tests
   * that don't want real waiting.
   */
  sleep?: (ms: number) => Promise<void>
}

export type RetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; lastError: unknown; attempts: number }

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<RetryResult<T>> {
  const sleep = opts.sleep ?? defaultSleep
  let lastError: unknown = null
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      const value = await fn()
      return { ok: true, value, attempts: attempt }
    } catch (err) {
      lastError = err
      opts.onAttemptFail?.(err, attempt)
      if (attempt < opts.maxAttempts) {
        const delay = opts.baseDelayMs * 2 ** (attempt - 1)
        await sleep(delay)
      }
    }
  }
  return { ok: false, lastError, attempts: opts.maxAttempts }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
