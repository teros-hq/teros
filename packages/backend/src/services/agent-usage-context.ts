/**
 * AsyncLocalStorage for agent usage instrumentation.
 *
 * Singleton used by `message-handler.ts:processAgentResponse()` to propagate
 * the current sessionUsageId down the async call tree. When a tool triggers
 * a sub-turn via delegation, the child `processAgentResponse` reads the
 * parent's id automatically via `usageContext.getStore()?.sessionUsageId`.
 *
 *
 *
 * Fail-safe: if no parent has called `run()`, getStore() returns undefined and
 * `parentSessionUsageId` is null (legitimate top-level turn).
 *
 * Health metric: `delegation_orphan_pct` (% sessions with
 * triggerKind='delegation' && parentSessionUsageId IS NULL) → Sentry alert
 * if > 0 (indicates the propagation was missed somewhere).
 */

import { AsyncLocalStorage } from "node:async_hooks"

export interface UsageContext {
  sessionUsageId: string
  /**
   * Root of the delegation tree (F3a — Latitude OTLP export). Propagated so a
   * delegated child inherits the same root and the export derives one tree-wide
   * `traceId`. For a top-level turn the caller seeds it to the turn's own
   * `sessionUsageId`.
   */
  rootSessionUsageId: string
}

/**
 * Singleton instance. Imported by `processAgentResponse` (to wrap the turn) and
 * by tool executor (to read context if needed, although today the executor
 * receives sessionUsageId via options for explicitness).
 */
export const usageContext = new AsyncLocalStorage<UsageContext>()

/**
 * Read the current sessionUsageId from the async context, if any.
 *
 * Returns null for top-level turns (no parent in the call stack).
 */
export function getCurrentSessionUsageId(): string | null {
  return usageContext.getStore()?.sessionUsageId ?? null
}
