/**
 * Graceful-shutdown drain helper (FASE 5c).
 *
 * Cron jobs schedule with setInterval and guard against concurrent ticks with a
 * private `running` flag. `stop()` clears the timer but does NOT wait for an
 * in-flight tick — so on SIGTERM the process could tear down Mongo while a tick
 * is mid-write. `waitUntilIdle` lets shutdown block until the current tick
 * finishes (or a bounded timeout elapses).
 */

/**
 * Poll `isRunning()` until it reports false, every `pollMs`, up to `timeoutMs`.
 * Returns true if it went idle in time, false on timeout (caller proceeds with
 * a forced shutdown — the leader lock TTL covers an interrupted tick).
 */
export async function waitUntilIdle(
  isRunning: () => boolean,
  opts: { timeoutMs: number; pollMs?: number },
): Promise<boolean> {
  const pollMs = opts.pollMs ?? 50
  const deadline = Date.now() + opts.timeoutMs
  while (isRunning()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return true
}
