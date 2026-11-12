/**
 * Tool-details cache for the permission-approval flow.
 *
 * Tool metadata (description + parameters + annotations) is static per MCA
 * version, so it is fetched lazily the first time a pending approval needs it and
 * kept in memory for the session. Nothing is persisted — see
 * docs/specs/mca/permission-approval-detail.md ("Client: useToolDetails").
 *
 * The fetcher is injected so this module imports neither React nor the WS
 * transport, which is what lets it be unit-tested under `bun test` (bun cannot
 * parse react-native's Flow-only source).
 */

import type {
  ToolAnnotations,
  ToolDetail,
  ToolDetailsResponse,
  ToolParameters,
} from "../../types/tool-details"

// Re-exported so existing importers of this module keep working; the shape itself
// lives in types/tool-details.ts (see the note there on why).
export type { ToolAnnotations, ToolDetail, ToolDetailsResponse, ToolParameters }

export type ToolDetailsFetcher = (
  appId: string,
  toolNames: string[],
) => Promise<ToolDetailsResponse>

/**
 * Failure reporter. Injected rather than calling `lib/sentry` here, because
 * importing it would pull `@sentry/react-native` into this module and break
 * `bun test` parsing — the same reason the fetcher is injected.
 */
export type ToolDetailsErrorReporter = (
  error: unknown,
  context: { appId: string; toolNames: string[] },
) => void

function keyOf(appId: string, toolName: string): string {
  return `${appId}:${toolName}`
}

export class ToolDetailsCache {
  private readonly entries = new Map<string, ToolDetail>()
  /** appId → the app's display name from the last response that carried it. */
  private readonly appNames = new Map<string, string>()
  private readonly failures = new Set<string>()
  /**
   * In-flight work keyed per `appId:toolName`, NOT per app. Per-app keying
   * coalesced only two concurrent callers: a third caller parked on the shared
   * promise would wake, find its name still missing, and start a duplicate
   * fetch. `PermissionDetail`, `ToolCallCard` and the default renderer of every
   * pending card of a batch mount against this cache at overlapping times, so
   * three or more concurrent callers is the normal case.
   */
  private readonly inFlight = new Map<string, Promise<void>>()
  /** Notified by `clearFailures()` — see `onRetryable`. */
  private readonly retryableListeners = new Set<() => void>()
  /**
   * Bumped by `reset()`. A fetch that was already in flight when the session was
   * torn down must not repopulate the cache when it lands — that is exactly the
   * leak `reset()` exists to prevent.
   */
  private epoch = 0

  constructor(
    private readonly fetcher: ToolDetailsFetcher,
    private readonly onError?: ToolDetailsErrorReporter,
  ) {}

  get(appId: string, toolName: string): ToolDetail | undefined {
    return this.entries.get(keyOf(appId, toolName))
  }

  /**
   * The app's display name, once a response carried it (PERMW-REQ-4).
   *
   * @spec PERMW-REQ-4
   */
  getAppName(appId: string): string | undefined {
    return this.appNames.get(appId)
  }

  hasFailed(appId: string, toolName: string): boolean {
    return this.failures.has(keyOf(appId, toolName))
  }

  /**
   * Ensure every name in `toolNames` is either cached or marked failed.
   * Resolves when the work is done; never rejects — failure is state, not a throw,
   * because the ControlsBar must stay interactive regardless.
   */
  async ensure(appId: string | undefined, toolNames: string[]): Promise<void> {
    if (!appId || toolNames.length === 0) return

    const settled = (name: string): boolean =>
      this.entries.has(keyOf(appId, name)) || this.failures.has(keyOf(appId, name))

    // Split the request three ways: already settled (skip), covered by someone
    // else's in-flight fetch (await theirs), genuinely missing (fetch ours).
    const waits: Array<Promise<void>> = []
    const missing: string[] = []
    for (const name of toolNames) {
      if (settled(name)) continue
      const pending = this.inFlight.get(keyOf(appId, name))
      if (pending) waits.push(pending)
      else missing.push(name)
    }

    if (missing.length > 0) {
      const work = this.load(appId, missing)
      for (const name of missing) this.inFlight.set(keyOf(appId, name), work)
      waits.push(
        work.finally(() => {
          // Delete by identity: a sibling fetch registered under the same name
          // must not be unregistered by ours settling first.
          for (const name of missing) {
            const key = keyOf(appId, name)
            if (this.inFlight.get(key) === work) this.inFlight.delete(key)
          }
        }),
      )
    }

    await Promise.all(waits)
  }

  private async load(appId: string, toolNames: string[]): Promise<void> {
    const startedAt = this.epoch
    try {
      const response = await this.fetcher(appId, toolNames)
      if (startedAt !== this.epoch) return
      if (response.appName) this.appNames.set(appId, response.appName)
      for (const tool of response.tools) {
        this.entries.set(keyOf(appId, tool.requestedName), tool)
      }
      // Anything the backend did not return (e.g. skipped for a broken schema)
      // is marked failed so the UI stops waiting on it.
      for (const name of toolNames) {
        if (!this.entries.has(keyOf(appId, name))) this.failures.add(keyOf(appId, name))
      }
    } catch (error) {
      if (startedAt !== this.epoch) return
      // Mark failed so the UI stops waiting, and REPORT — a swallowed error
      // returning a degraded result violates engineering principle 2. The
      // degradation itself (card renders without metadata) is sanctioned by the
      // spec; its silence is not.
      for (const name of toolNames) this.failures.add(keyOf(appId, name))
      try {
        this.onError?.(error, { appId, toolNames })
      } catch {
        // The REPORTER itself threw. This is the one place a bare catch is
        // correct: there is no remaining channel to report to, and letting it
        // escape would reject ensure() — surfacing as an unhandled rejection in
        // the render tree and breaking the "Allow/Deny stays interactive"
        // guarantee this whole class exists to uphold.
      }
    }
  }

  /**
   * Observe the moment remembered failures become retryable.
   *
   * Without this, `clearFailures()` only helped cards that had not mounted yet:
   * an ALREADY-MOUNTED card sits on a `failed: true` render with its fetch effect
   * keyed on `[appId, toolNames]`, so nothing re-runs and the "details
   * unavailable" notice stays for a connection that has since recovered. Callers
   * subscribe to re-drive their own fetch. Returns an unsubscribe.
   */
  onRetryable(listener: () => void): () => void {
    this.retryableListeners.add(listener)
    return () => {
      this.retryableListeners.delete(listener)
    }
  }

  /**
   * Drop remembered failures so the next `ensure()` retries them.
   *
   * A failure is sticky by design — the UI must stop waiting, and re-fetching on
   * every render would hammer a broken backend. But sticky is not permanent: one
   * dropped WebSocket frame would otherwise degrade every future approval card
   * for that app for the rest of the session. Call this when the connection is
   * re-established, which is the event that makes a retry worth attempting.
   *
   * Notifies `onRetryable` subscribers ONLY when something was actually dropped,
   * so a reconnect on a healthy session re-renders nothing.
   */
  clearFailures(appId?: string): void {
    let cleared = false
    if (!appId) {
      cleared = this.failures.size > 0
      this.failures.clear()
    } else {
      const prefix = `${appId}:`
      for (const key of this.failures) {
        if (key.startsWith(prefix)) {
          this.failures.delete(key)
          cleared = true
        }
      }
    }
    if (!cleared) return
    for (const listener of this.retryableListeners) {
      try {
        listener()
      } catch {
        // A subscriber that throws must not stop the others from being told, nor
        // escape into the transport's "connected" handler — same reasoning as the
        // reporter guard in load().
      }
    }
  }

  /**
   * Full teardown — test seam and session-destroy hook (see SessionManager).
   * Bumping the epoch is what stops a fetch already in flight from repopulating
   * the cache after the session it belonged to is gone.
   */
  reset(): void {
    this.epoch += 1
    this.entries.clear()
    this.appNames.clear()
    this.failures.clear()
    this.inFlight.clear()
  }
}
