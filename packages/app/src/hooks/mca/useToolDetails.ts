/**
 * useToolDetails — lazily load static tool metadata for pending approvals.
 *
 * Call ONLY while a tool is in `pending_permission`. Returns whatever is cached
 * plus loading/failed flags; consumers must render a usable card in every state,
 * because the Allow/Deny controls are never allowed to block on this fetch.
 */

import { useEffect, useMemo, useState } from "react"
import { type ToolDetail, ToolDetailsCache } from "../../components/mca/tool-details-cache"
import { captureException } from "../../lib/sentry"
import { getTerosClient } from "../../services/terosClientSingleton"

const cache = new ToolDetailsCache(
  (appId, toolNames) => getTerosClient().app.getToolDetails(appId, toolNames),
  // The cache stays Sentry-free so bun can parse it; the reporter is wired here.
  (error, context) => captureException(error, { source: "ToolDetailsCache", ...context }),
)

/**
 * Exposed for tests and for the session-lifecycle hooks:
 * `reset()` on session teardown (wired in store/session/SessionManager.ts) and
 * `clearFailures()` on transport reconnect (wired in services/TerosClient.ts).
 * Without the first, a second account in the same tab reads metadata cached
 * under the first account's installs; without the second, one dropped frame
 * degrades every later approval card for the rest of the session.
 */
export const toolDetailsCache = cache

/**
 * Subscribe once to transport recovery so a failure caused by a dropped
 * connection can be retried.
 *
 * A failure has to be sticky — the card must stop waiting, and re-fetching on
 * every render would hammer a backend that is already unhappy. But sticky must
 * not mean permanent: without this, a single dropped frame during the first
 * approval leaves every later approval card for that app degraded for the rest
 * of the session. Reconnection is the precise event that makes a retry worth
 * attempting.
 *
 * Subscribed lazily on first hook use rather than at module load, so importing
 * this module never forces the client singleton into existence.
 */
let reconnectHookInstalled = false
function ensureReconnectRetry(): void {
  if (reconnectHookInstalled) return
  reconnectHookInstalled = true
  try {
    getTerosClient().on("connected", () => cache.clearFailures())
  } catch {
    // No transport in this environment (tests) — nothing to recover from.
    reconnectHookInstalled = false
  }
}

/**
 * Counter that advances whenever the cache drops remembered failures.
 *
 * `clearFailures()` on its own only helped cards that had not mounted yet: a card
 * already showing "details unavailable" has its fetch effect keyed on
 * `[appId, toolNames]`, neither of which changes on reconnect, so it would sit on
 * the stale failure for the rest of the session. Feeding this into the effect's
 * deps is what turns the retry from a promise into an actual re-fetch.
 */
function useRetryEpoch(): number {
  const [epoch, setEpoch] = useState(0)
  useEffect(() => cache.onRetryable(() => setEpoch((e) => e + 1)), [])
  return epoch
}

export interface UseToolDetailsResult {
  /** Keyed by the requested (possibly namespaced) tool name. */
  details: Record<string, ToolDetail>
  /** The app's display name, once the details carried it. @spec PERMW-REQ-4 */
  appName?: string
  loading: boolean
  failed: boolean
}

export function useToolDetails(
  appId: string | undefined,
  toolNames: string[],
): UseToolDetailsResult {
  // Stable key so the effect does not re-run on a new array with equal contents.
  const namesKey = toolNames.join(",")
  const [tick, setTick] = useState(0)
  const [loading, setLoading] = useState(false)
  const retryEpoch = useRetryEpoch()

  // biome-ignore lint/correctness/useExhaustiveDependencies: namesKey stands in for toolNames; retryEpoch re-arms the fetch after a reconnect
  useEffect(() => {
    // `loading` is cleared on every early return, not just on settle. Returning
    // without clearing it latched `loading: true` for the component's remaining
    // lifetime whenever the tool names changed to an already-cached set while an
    // earlier fetch was still in flight.
    if (!appId || toolNames.length === 0) {
      setLoading(false)
      return
    }
    const pending = toolNames.filter((n) => !cache.get(appId, n) && !cache.hasFailed(appId, n))
    if (pending.length === 0) {
      setLoading(false)
      return
    }

    ensureReconnectRetry()
    let active = true
    setLoading(true)
    cache.ensure(appId, pending).then(() => {
      if (!active) return
      setLoading(false)
      setTick((t) => t + 1)
    })
    return () => {
      active = false
    }
  }, [appId, namesKey, retryEpoch])

  // biome-ignore lint/correctness/useExhaustiveDependencies: namesKey stands in for toolNames; tick forces a refresh after an async fill
  return useMemo(() => {
    if (!appId) return { details: {}, loading: false, failed: false }
    const details: Record<string, ToolDetail> = {}
    let failed = false
    for (const name of toolNames) {
      const found = cache.get(appId, name)
      if (found) details[name] = found
      else if (cache.hasFailed(appId, name)) failed = true
    }
    return { details, appName: cache.getAppName(appId), loading, failed }
  }, [appId, namesKey, loading, tick, retryEpoch])
}
