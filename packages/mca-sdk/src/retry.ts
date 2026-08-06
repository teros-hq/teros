/**
 * Resilience helpers for MCA tool handlers.
 *
 * Criterion 18 of MCA-RUNBOOK.md (resilience): external API calls should
 * have explicit timeouts and, when idempotent, retry transient failures
 * with exponential backoff.
 *
 * The caller decides whether an operation is safe to retry — this module
 * intentionally does not try to infer idempotency. Defaults retry only
 * GET-like symptoms (5xx status, timeout, network errors).
 */

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Rejects with TimeoutError if `fn` doesn't settle within `ms` milliseconds.
 * The underlying work is NOT cancelled — JS Promises cannot be cancelled.
 * Callers that need true cancellation must plumb AbortSignal into `fn`.
 */
export async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return fn();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new TimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export type BackoffStrategy = 'exponential' | 'linear';

export interface RetryOptions {
  /** Max retry attempts after the first try. Default 3. */
  retries?: number;
  /** Initial delay in ms. Default 100. */
  initialDelayMs?: number;
  /** Cap for the delay (ms). Default 5000. */
  maxDelayMs?: number;
  /** 'exponential' doubles each attempt; 'linear' adds initialDelayMs each time. */
  backoff?: BackoffStrategy;
  /** Predicate to decide if an error is retryable. Default: only 5xx, timeouts, network. */
  shouldRetry?: (err: unknown) => boolean;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_INITIAL_DELAY = 100;
const DEFAULT_MAX_DELAY = 5000;

/**
 * Retries `fn` on transient failures with backoff. Callers must only pass
 * idempotent operations (GET, HEAD, PUT with idempotency keys, etc.).
 * Mutations without idempotency keys MUST NOT be wrapped.
 *
 * Default shouldRetry retries on:
 *   - Errors whose message contains 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'
 *   - TimeoutError (thrown by withTimeout)
 *   - HTTP responses with status >= 500 (when err exposes `status` or `statusCode`)
 *
 * Never retries 4xx by default — those are permanent (bad request, unauthorized).
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const initialDelay = opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY;
  const maxDelay = opts.maxDelayMs ?? DEFAULT_MAX_DELAY;
  const backoff: BackoffStrategy = opts.backoff ?? 'exponential';
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err)) throw err;
      const delay = computeDelay(attempt, initialDelay, maxDelay, backoff);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function computeDelay(
  attempt: number,
  initial: number,
  max: number,
  backoff: BackoffStrategy,
): number {
  const delay =
    backoff === 'exponential' ? initial * 2 ** attempt : initial * (attempt + 1);
  return Math.min(delay, max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (err === null || typeof err !== 'object') return false;
  const e = err as { message?: string; code?: string; status?: number; statusCode?: number };
  if (e.status && e.status >= 500) return true;
  if (e.statusCode && e.statusCode >= 500) return true;
  const msg = e.message ?? '';
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(msg)) return true;
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/.test(e.code ?? '')) return true;
  return false;
}
