/**
 * Common test helpers and utilities.
 */

/**
 * Wait for a given number of milliseconds.
 * Useful for letting async side-effects settle in tests.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async assertion up to `attempts` times with `delayMs` between tries.
 * Throws the last error if all attempts fail.
 *
 * @example
 *   await retry(() => expect(db.find()).toHaveLength(1));
 */
export async function retry(
  fn: () => Promise<void> | void,
  attempts = 5,
  delayMs = 100,
): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Generate a random string of length `n` (alphanumeric).
 * Useful for unique IDs in tests that run in parallel.
 */
export function randomId(n = 8): string {
  return Math.random().toString(36).slice(2, 2 + n).padEnd(n, '0');
}
