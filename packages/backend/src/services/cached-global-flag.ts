/**
 * A boolean GLOBAL feature flag cached in-memory, refreshed on a timer.
 *
 * `FeatureFlagService.resolve` is async (a Mongo lookup). The F3a export gate is
 * evaluated once per finished turn and must be synchronous and O(1) — resolving
 * per turn would be one query per turn. This resolves the flag on a fixed
 * cadence and hands back a sync getter (the plan's "flag resolved once per
 * batch", generalized to a fixed interval so it is independent of batch size).
 *
 * Fail-safe: the initial value is `false` until the first refresh resolves; on a
 * resolve error the last known value is kept (never flips the flag on a blip).
 * The timer is `unref`'d so it never keeps the process alive.
 *
 * Reused by F3b for `observability.latitude-export-content`.
 */

import type { FeatureFlagService } from "./feature-flag-service.js"

export interface CachedFlag {
  /** Last resolved value. Synchronous, O(1). */
  get(): boolean
  /** Stop the refresh timer (call on shutdown). */
  stop(): void
}

export function createCachedGlobalFlag(
  flags: FeatureFlagService,
  key: string,
  opts: { intervalMs?: number; onError?: (err: unknown) => void } = {},
): CachedFlag {
  let value = false

  const refresh = async (): Promise<void> => {
    try {
      value = (await flags.resolve(key, {})) === true
    } catch (err) {
      // Keep the last known value — a transient resolve error must not toggle it.
      opts.onError?.(err)
    }
  }

  void refresh()
  const timer = setInterval(() => void refresh(), opts.intervalMs ?? 30_000)
  timer.unref?.()

  return {
    get: () => value,
    stop: () => clearInterval(timer),
  }
}
