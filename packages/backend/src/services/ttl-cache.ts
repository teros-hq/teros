/**
 * Tiny in-memory TTL cache (A4.5 / TER-675).
 *
 * The admin dashboard auto-refreshes every 60s; K admins fire the SAME expensive
 * aggregation each tick, and because each client computes `to = now` the naive
 * params never collide. A short server-side TTL cache — keyed by a range that is
 * normalised to the minute — collapses those K identical aggregations into one
 * per minute. Single-process (the backend runs fork-mode), so a plain Map is
 * enough; no cross-instance coherence needed.
 *
 * `now` is injectable so the TTL is deterministic under test.
 */

export class TtlCache<V> {
  private readonly store = new Map<string, { value: V; expiresAt: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Cached value if present and unexpired; otherwise `undefined` (and evicted). */
  get(key: string): V | undefined {
    const hit = this.store.get(key)
    if (!hit) return undefined
    if (this.now() >= hit.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    return hit.value
  }

  set(key: string, value: V): void {
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs })
  }

  /** Live entry count (unexpired entries are NOT lazily purged here). */
  get size(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }
}

/**
 * Round an epoch-ms instant DOWN to the start of its minute. Used to normalise
 * the query's `to` so K admins whose `to = now` differ by seconds share one
 * cache entry within the same minute.
 */
export function floorToMinute(epochMs: number): number {
  return Math.floor(epochMs / 60_000) * 60_000
}
