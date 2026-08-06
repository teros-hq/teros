/**
 * Model-health aggregator (TER-616 / F1).
 *
 * Merges the per-`actualProvider×modelId` `modelHealth` blocks embedded in the
 * hourly rollups across a time range and derives the query-time figures the
 * admin window shows: p50/p95/p99 latency + TTFT, error-rate by kind, and
 * success-rate. The histograms are additive (see `latency-histogram.ts`), so
 * merging hourly buckets is exact; the percentiles are derived only after the
 * merge (they are NOT additive and must never be averaged across hours).
 *
 * Pure: takes plain rollup documents, returns plain summaries — no DB, fully
 * unit-testable / mutation-verifiable.
 */

import type {
  AgentUsageErrorKind,
  AgentUsageRollupHourly,
  AgentUsageSession,
  AgentUsageSessionStatus,
  ModelHealthEntry,
} from "../types/database.js"
import { truncateToBucket } from "./agent-usage-query-helper.js"
import { emptyHistogram, mergeInto, recordValue, summarize } from "./latency-histogram.js"

/** Per-`actualProvider×modelId` health figures over the requested range. */
export interface ModelHealthSummary {
  actualProvider: string
  modelId: string
  /** Turns observed (throughput). */
  requestCount: number
  /**
   * Turns per minute over the queried window (`requestCount / periodMinutes`).
   * The pure aggregator can't know the range, so the handler fills it (same
   * pattern as `thumbsUp`/`thumbsDown`); absent in the pure aggregator output.
   */
  throughputPerMin?: number
  latency: ReturnType<typeof summarize>
  ttft: ReturnType<typeof summarize>
  statusCounts: Partial<Record<AgentUsageSessionStatus, number>>
  errorCounts: Partial<Record<AgentUsageErrorKind, number>>
  /** Errored turns per honest-attribution sub-reason (TER-698/TER-700). Additive. */
  subReasonCounts?: Partial<Record<string, number>>
  /** Provider finish_reason breakdown (`length` = truncation proxy, §3.1). */
  finishReasons: Partial<Record<string, number>>
  /** (errored + timed_out) / requestCount ∈ [0,1] — a timeout IS a degradation (R8.4). */
  errorRate: number
  /**
   * completed / (requestCount − aborted) ∈ [0,1], or `null` for an all-aborted
   * bucket (no measurable success — "—", not a red 0%). User aborts excluded
   * from the denominator (R8.4, A3.3).
   */
  successRate: number | null
  /** timed_out / requestCount ∈ [0,1]. */
  timeoutRate: number
  /** aborted / requestCount ∈ [0,1] (user-initiated, not a model fault). */
  abortRate: number
  /** (rate_limited + overloaded) / requestCount ∈ [0,1] — capacity saturation (§2.1, R6.2). */
  saturationRate: number
  /** failover turns / requestCount ∈ [0,1] — Fireworks→Together rate (R3.5). */
  fallbackRate: number
  /**
   * empty completions / `measuredCount` (reliable-usage turns) ∈ [0,1], or
   * `null` when nothing measurable landed. Denominated over the measurable
   * population, not requestCount (A3.3).
   */
  emptyRate: number | null
  /**
   * truncated turns (finish_reason=length) / `stopReasonCount` (turns with a
   * known finish_reason) ∈ [0,1], or `null` when no finish_reason was seen (A3.3).
   */
  truncationRate: number | null
  /** failing tools / total tools ∈ [0,1] (0 when no tools ran) (R4.3). */
  toolErrorRate: number
  /** Total tool executions across the range — context/denominator for toolErrorRate. */
  toolCallCount: number
  /**
   * 👍 / 👎 on messages this upstream×model produced, counted at query time
   * (the feedback arrives too late for the hourly rollup). Joined from
   * `message_feedback` → `llm_usage.messageId` (R4.4). Populated by the handler
   * via `applyThumbsToSummaries`; absent in the pure aggregator output.
   */
  thumbsUp?: number
  thumbsDown?: number
}

/** Per-`actualProvider::modelId` thumbs tally, the shape the WS query builds. */
export type ThumbsByKey = Record<string, { up: number; down: number }>

/**
 * Enrich summaries with the query-time thumbs tally, keyed by
 * `${actualProvider}::${modelId}` (the SAME key the rollup uses). Mutates in
 * place and always sets the fields (0 when no feedback landed), so the window
 * can show "👍 0 / 👎 0" rather than a missing widget. Pure + unit-testable.
 */
export function applyThumbsToSummaries(
  summaries: ModelHealthSummary[],
  thumbs: ThumbsByKey,
): void {
  for (const s of summaries) {
    const t = thumbs[`${s.actualProvider}::${s.modelId}`]
    s.thumbsUp = t?.up ?? 0
    s.thumbsDown = t?.down ?? 0
  }
}

/**
 * Set each summary's `throughputPerMin = requestCount / periodMinutes` — turns
 * per minute over the queried window (F1.1). Mutates in place. The period comes
 * from the query range `[from, to)`, which the pure aggregator doesn't know, so
 * the handler supplies it (same split as `applyThumbsToSummaries`). A
 * non-positive period yields 0 rather than `Infinity`/`NaN` — the handler
 * already validates `from < to`, so this is belt-and-braces. Pure + testable.
 */
export function applyThroughputToSummaries(
  summaries: ModelHealthSummary[],
  periodMinutes: number,
): void {
  for (const s of summaries) {
    s.throughputPerMin = periodMinutes > 0 ? s.requestCount / periodMinutes : 0
  }
}

type RollupSlice = Pick<AgentUsageRollupHourly, "modelHealth">

function addCounts<K extends string>(
  dst: Partial<Record<K, number>>,
  src: Partial<Record<K, number>>,
): void {
  for (const k of Object.keys(src) as K[]) {
    dst[k] = (dst[k] ?? 0) + (src[k] ?? 0)
  }
}

function freshEntry(actualProvider: string, modelId: string): ModelHealthEntry {
  return {
    actualProvider,
    modelId,
    requestCount: 0,
    latency: emptyHistogram(),
    ttft: emptyHistogram(),
    statusCounts: {},
    errorCounts: {},
    subReasonCounts: {},
    finishReasons: {},
    emptyCount: 0,
    measuredCount: 0,
    stopReasonCount: 0,
    fallbackCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
  }
}

/**
 * Fold ONE session into a `modelHealth` map, keyed by `${actualProvider}::${model}`
 * — the single source of truth for "what a session contributes to model-health"
 * (latency/TTFT samples, status, error kind, finish-reason, empty/fallback/tool
 * proxies). `RollupAccumulator` uses it for the hourly rollup; the live handler
 * uses it (via `buildModelHealthFromSessions`) for the in-progress hour that has
 * no rollup yet. Extracting it keeps the two paths from diverging (TER-645/#2).
 *
 * Latency/TTFT are turn-instant (not divisible by a cross-midnight fraction), so
 * they go in whole. `actualProvider` falls back to the logical `provider` for
 * pre-F0 sessions, keeping the key total.
 */
export function accumulateSessionModelHealth(
  modelHealth: Record<string, ModelHealthEntry>,
  session: AgentUsageSession,
): void {
  const actualProvider = session.actualProvider ?? session.provider
  const model = session.actualModel ?? session.modelId
  const key = `${actualProvider}::${model}`
  const entry = modelHealth[key] ?? freshEntry(actualProvider, model)

  entry.requestCount += 1
  if (typeof session.latencyMs === "number") recordValue(entry.latency, session.latencyMs)
  if (typeof session.ttftMs === "number") recordValue(entry.ttft, session.ttftMs)

  entry.statusCounts[session.status] = (entry.statusCounts[session.status] ?? 0) + 1
  if (session.status === "errored" && session.errorKind) {
    entry.errorCounts[session.errorKind] = (entry.errorCounts[session.errorKind] ?? 0) + 1
  }
  // Honest-attribution sub-reason breakdown (TER-698/TER-700) — additive, same
  // guard as errorCounts. Feeds the ops KPI split (capacity vs account-limit).
  if (session.status === "errored" && session.errorSubReason) {
    entry.subReasonCounts ??= {}
    entry.subReasonCounts[session.errorSubReason] =
      (entry.subReasonCounts[session.errorSubReason] ?? 0) + 1
  }

  // Quality proxies (§3.1) + failover (TER-617/F3) — all additive.
  if (session.stopReason) {
    entry.finishReasons![session.stopReason] = (entry.finishReasons![session.stopReason] ?? 0) + 1
    // Denominator for truncationRate: only turns whose finish_reason is known.
    entry.stopReasonCount = (entry.stopReasonCount ?? 0) + 1
  }
  // Denominator for emptyRate: turns with reliable usage. `emptyCount` excludes
  // usagePartial turns, so the denominator must too, or the rate skews green.
  if (!session.usagePartial) {
    entry.measuredCount = (entry.measuredCount ?? 0) + 1
  }
  // Empty-response proxy: a clean completion with zero output tokens. Skip turns
  // with partial/unreliable usage so they don't read as empty.
  if (session.status === "completed" && session.outputTokens === 0 && !session.usagePartial) {
    entry.emptyCount = (entry.emptyCount ?? 0) + 1
  }
  if (session.fallbackUsed) entry.fallbackCount = (entry.fallbackCount ?? 0) + 1
  entry.toolCallCount = (entry.toolCallCount ?? 0) + session.toolCallCount
  entry.toolErrorCount = (entry.toolErrorCount ?? 0) + (session.toolErrorCount ?? 0)

  modelHealth[key] = entry
}

/**
 * Build a `modelHealth` map from raw sessions (TER-645/#2) — used to aggregate
 * the in-progress hour live, since the rollup job only writes CLOSED hours.
 */
export function buildModelHealthFromSessions(
  sessions: AgentUsageSession[],
): Record<string, ModelHealthEntry> {
  const modelHealth: Record<string, ModelHealthEntry> = {}
  for (const s of sessions) accumulateSessionModelHealth(modelHealth, s)
  return modelHealth
}

function toSummary(e: ModelHealthEntry): ModelHealthSummary {
  // requestCount is the denominator. Guard div-by-zero (an entry only exists if
  // at least one turn landed in it, so this is belt-and-braces).
  const denom = e.requestCount > 0 ? e.requestCount : 1
  const errored = e.statusCounts.errored ?? 0
  const completed = e.statusCounts.completed ?? 0
  const timedOut = e.statusCounts.timed_out ?? 0
  const aborted = e.statusCounts.aborted ?? 0
  const rateLimited = e.errorCounts.rate_limited ?? 0
  const overloaded = e.errorCounts.overloaded ?? 0
  const truncated = e.finishReasons?.length ?? 0
  const toolCalls = e.toolCallCount ?? 0
  // successRate excludes user aborts from the denominator — an abort is neither
  // a model success nor a model failure. An all-aborted bucket has no measurable
  // success → null ("—"), never a red 0% (A3.3).
  const successDenom = e.requestCount - aborted
  // emptyRate/truncationRate denominate over the MEASURABLE population, not
  // requestCount (A3.3): `measuredCount` = reliable-usage turns (emptyRate),
  // `stopReasonCount` = turns with a known finish_reason (truncationRate). Legacy
  // rollups predate these fields → fall back to `requestCount` so historical data
  // keeps its old (pre-fix) rate rather than showing a spurious "—".
  const measuredDenom = e.measuredCount ?? e.requestCount
  const stopDenom = e.stopReasonCount ?? e.requestCount
  return {
    actualProvider: e.actualProvider,
    modelId: e.modelId,
    requestCount: e.requestCount,
    latency: summarize(e.latency),
    ttft: summarize(e.ttft),
    statusCounts: e.statusCounts,
    errorCounts: e.errorCounts,
    subReasonCounts: e.subReasonCounts ?? {},
    finishReasons: e.finishReasons ?? {},
    // A timeout is a degradation → it belongs in the error-rate numerator (R8.4).
    errorRate: (errored + timedOut) / denom,
    successRate: successDenom > 0 ? completed / successDenom : null,
    timeoutRate: timedOut / denom,
    abortRate: aborted / denom,
    saturationRate: (rateLimited + overloaded) / denom,
    fallbackRate: (e.fallbackCount ?? 0) / denom,
    emptyRate: measuredDenom > 0 ? (e.emptyCount ?? 0) / measuredDenom : null,
    truncationRate: stopDenom > 0 ? truncated / stopDenom : null,
    toolErrorRate: toolCalls > 0 ? (e.toolErrorCount ?? 0) / toolCalls : 0,
    toolCallCount: toolCalls,
  }
}

/**
 * Merge every rollup's `modelHealth` by `${actualProvider}::${modelId}` and
 * return the summaries sorted by descending `requestCount` (busiest first).
 * Rollups without a `modelHealth` block (legacy/pre-F1) are skipped.
 */
export function aggregateModelHealth(rollups: RollupSlice[]): ModelHealthSummary[] {
  const merged = new Map<string, ModelHealthEntry>()

  for (const rollup of rollups) {
    if (!rollup.modelHealth) continue
    for (const [key, entry] of Object.entries(rollup.modelHealth)) {
      let acc = merged.get(key)
      if (!acc) {
        acc = freshEntry(entry.actualProvider, entry.modelId)
        merged.set(key, acc)
      }
      acc.requestCount += entry.requestCount
      mergeInto(acc.latency, entry.latency)
      mergeInto(acc.ttft, entry.ttft)
      addCounts(acc.statusCounts, entry.statusCounts)
      addCounts(acc.errorCounts, entry.errorCounts)
      acc.subReasonCounts ??= {}
      addCounts(acc.subReasonCounts, entry.subReasonCounts ?? {})
      addCounts(acc.finishReasons ?? (acc.finishReasons = {}), entry.finishReasons ?? {})
      acc.emptyCount = (acc.emptyCount ?? 0) + (entry.emptyCount ?? 0)
      // Denominators for empty/truncation rates — fall back to requestCount for
      // legacy entries so their contribution matches the pre-fix behaviour.
      acc.measuredCount = (acc.measuredCount ?? 0) + (entry.measuredCount ?? entry.requestCount)
      acc.stopReasonCount = (acc.stopReasonCount ?? 0) + (entry.stopReasonCount ?? entry.requestCount)
      acc.fallbackCount = (acc.fallbackCount ?? 0) + (entry.fallbackCount ?? 0)
      acc.toolCallCount = (acc.toolCallCount ?? 0) + (entry.toolCallCount ?? 0)
      acc.toolErrorCount = (acc.toolErrorCount ?? 0) + (entry.toolErrorCount ?? 0)
    }
  }

  return [...merged.values()]
    .map(toSummary)
    .sort(
      (a, b) =>
        b.requestCount - a.requestCount ||
        // Deterministic tiebreak so equal-volume models keep a stable order
        // across renders and across the JS/Mongo merge paths (TER-668).
        `${a.actualProvider}::${a.modelId}`.localeCompare(`${b.actualProvider}::${b.modelId}`),
    )
}

type RollupHourSlice = Pick<AgentUsageRollupHourly, "hourBucket" | "modelHealth">

/** One hour of the model-health time-series (F1.2). */
export interface ModelHealthHourBucket {
  /** Hour bucket (UTC, truncated to the hour — the rollup's own bucket). */
  hourBucket: Date
  /** Per-`actualProvider×modelId` health for THIS hour only. */
  models: ModelHealthSummary[]
}

/**
 * Time-series variant (F1.2): group the rollups by their `hourBucket` and
 * aggregate EACH hour on its own — deliberately NOT merging across hours, so
 * the caller sees how volume/health moved over time (vs `aggregateModelHealth`,
 * which collapses the whole range into one figure). Buckets are returned in
 * ascending chronological order. Rollups sharing an hour (different
 * user/agent/workspace group keys) are aggregated together into that hour.
 */
export function aggregateModelHealthByHour(
  rollups: RollupHourSlice[],
  // Bucket granularity (2026-07-07 monitoring audit, P5): 'day'/'week' merge
  // the ADDITIVE histograms of the contained hourly slices BEFORE deriving
  // percentiles, so coarse p50/p95/p99 stay exact — never an average of hourly
  // percentiles. 7d/30d views need this; 720 hourly bars are sub-pixel.
  bucketUnit: "hour" | "day" | "week" = "hour",
): ModelHealthHourBucket[] {
  const byHour = new Map<number, RollupHourSlice[]>()
  for (const r of rollups) {
    const t = truncateToBucket(r.hourBucket, bucketUnit).getTime()
    const group = byHour.get(t)
    if (group) group.push(r)
    else byHour.set(t, [r])
  }
  return [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, group]) => ({ hourBucket: new Date(t), models: aggregateModelHealth(group) }))
}
