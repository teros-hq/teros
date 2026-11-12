/**
 * Hourly rollup job.
 *
 * Two projections are computed per closed hour:
 *
 *   - agent_usage_rollups_hourly (per user × agent × provider × workspace)
 *       with modelMix embedded and split-proportional tokens / activeMs for
 *       sessions that cross midnight.
 *
 *   - agent_usage_rollups_user_hourly (per user × workspace) with
 *       userActiveMs = union of session intervals coalesced in JS (decision
 *       #26, analytical) and userWorkMs = SUM of per-session overlaps
 *       (decision #29, the billed quota metric — parallel agents each count).
 *
 * Cutoff policy (decision #20): a session is included in the hour `h` if
 * `endedAt <= h.end`. Sessions still running across the cutoff are picked
 * up in the next run when they close — so an hour is only marked complete
 * once no recent session overlapping it is still open (BIL-2), and the
 * agent-hours tracker bills only completed hours (see computeBillableHorizon).
 * Idempotent via the unique compound index on `(hourBucket, groupKey...)`.
 *
 * Catch-up: at every tick, scans the last `catchUpHours` (default 72h,
 * configurable via ROLLUP_CATCHUP_HOURS) for missing hour buckets and processes
 * them in chronological order.
 *
 * Worker Thread isolation (decision #27): the implementation below is
 * cursor-streamed and yields between writes, so it does not block the event
 * loop with reasonable volumes. Moving the job to a dedicated
 * `node:worker_threads` instance is a follow-up if the rollup latency grows
 * — the public API (`runOnce`, `processHour`) is shaped to make that swap
 * mechanical (no shared state with the request path).
 *
 * Design doc: docs/usage-instrumentation.md §9 — Job de rollup horario
 */

import { generateUsageRollupId } from "@teros/core"
import type { Collection, Db } from "mongodb"
import type { Logger } from "pino"
import type {
  AgentUsageRollupHourly,
  AgentUsageRollupRun,
  AgentUsageRollupUserHourly,
  AgentUsageSession,
} from "../types/database.js"
import { AgentRollupGroupKey } from "./agent-rollup-group-key.js"
import { EXCLUDE_DEMO_SEED } from "./agent-usage-demo-filter.js"
import { LEADER_LOCKS, type LeaderElectionService } from "./leader-election.js"
import { RollupAccumulator } from "./rollup-accumulator.js"

export interface RollupJobOptions {
  /** Minutes after each closed hour to start the rollup (default :05). */
  offsetMin: number
  /** How many hours back to scan for missing buckets at each tick. */
  catchUpHours: number
  /**
   * Lease duration when acquiring the distributed leader lock. The rollup
   * tick can take longer than the reconciler (cursor stream over all
   * sessions of N hours), so the default is generous.
   */
  leaderLockTtlMs: number
}

/**
 * Resolve the catch-up window (A1.7 / TER-675 / TER-650). Default 72h: if the job
 * is stuck for longer than this (DB overload, multi-day outage) the older hour
 * buckets fall off and their agent-hours are never billed — a silent revenue leak,
 * so we keep three days of headroom (a weekend outage stays recoverable, still well
 * within session retention; the rollup_lag_hours alarm fires >6h long before this
 * bound). `ROLLUP_CATCHUP_HOURS` lets ops widen it further to backfill after an
 * incident. Clamped to [1, 720] (30d, the session TTL floor) so a typo can't make
 * every tick a full-history scan.
 */
export function resolveCatchUpHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ROLLUP_CATCHUP_HOURS)
  if (!Number.isFinite(raw) || raw <= 0) return 72
  return Math.min(720, Math.floor(raw))
}

export const DEFAULT_ROLLUP_OPTS: RollupJobOptions = {
  offsetMin: 5,
  // Configurable via ROLLUP_CATCHUP_HOURS (dev/TER-675); defaults to 72h so a
  // multi-day outage doesn't silently drop un-billed hour buckets (TER-650).
  catchUpHours: resolveCatchUpHours(),
  leaderLockTtlMs: 5 * 60_000,
}

export interface RollupMetrics {
  rollup_job_duration_ms: number
  rollup_docs_written: number
  rollup_errors: number
  rollup_lag_hours: number
  rollup_last_run_at: number | null
  /** Ticks where another instance held the leader lock (we skipped). */
  rollup_skipped_not_leader: number
}

export class AgentUsageRollupJob {
  private timer: NodeJS.Timeout | null = null
  private running = false

  // Metrics
  private rollup_job_duration_ms = 0
  private rollup_docs_written = 0
  private rollup_errors = 0
  private rollup_lag_hours = 0
  private rollup_last_run_at: number | null = null
  private rollup_skipped_not_leader = 0

  private hourlyCol: Collection<AgentUsageRollupHourly>
  private userHourlyCol: Collection<AgentUsageRollupUserHourly>
  private sessionsCol: Collection<AgentUsageSession>
  private runsCol: Collection<AgentUsageRollupRun>

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    /**
     * Optional distributed leader lock. When set, the periodic `start()` tick
     * only runs if this instance currently owns the lock. Pass null for
     * single-instance / test scenarios.
     */
    private readonly leader: LeaderElectionService | null = null,
    public readonly opts: RollupJobOptions = DEFAULT_ROLLUP_OPTS,
  ) {
    this.hourlyCol = db.collection<AgentUsageRollupHourly>("agent_usage_rollups_hourly")
    this.userHourlyCol = db.collection<AgentUsageRollupUserHourly>(
      "agent_usage_rollups_user_hourly",
    )
    this.sessionsCol = db.collection<AgentUsageSession>("agent_usage_sessions")
    this.runsCol = db.collection<AgentUsageRollupRun>("agent_usage_rollup_runs")
  }

  start(): void {
    if (this.timer !== null) return
    // Run every 5 min to pick up the closed hour at :05 and catch-up gaps.
    this.timer = setInterval(
      () => {
        this.tick().catch((err) => {
          this.log.error({ err }, "agent-usage-rollup-job: tick failed")
        })
      },
      5 * 60 * 1000,
    )
    if (typeof this.timer.unref === "function") this.timer.unref()
  }

  /**
   * One scheduled tick. Guards the work behind the leader lock; the lock is
   * NOT held for the entire run — we just gate entry. If the tick takes
   * longer than `leaderLockTtlMs`, another instance may acquire next tick;
   * the work is idempotent so this is harmless.
   */
  private async tick(): Promise<void> {
    if (this.leader) {
      const acquired = await this.leader.tryAcquire(
        LEADER_LOCKS.RollupAgentUsage,
        this.opts.leaderLockTtlMs,
      )
      if (!acquired) {
        this.rollup_skipped_not_leader++
        return
      }
    }
    await this.runOnce()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  getMetrics(): RollupMetrics {
    return {
      rollup_job_duration_ms: this.rollup_job_duration_ms,
      rollup_docs_written: this.rollup_docs_written,
      rollup_errors: this.rollup_errors,
      rollup_lag_hours: this.rollup_lag_hours,
      rollup_last_run_at: this.rollup_last_run_at,
      rollup_skipped_not_leader: this.rollup_skipped_not_leader,
    }
  }

  /**
   * Run a tick: process all missing hour buckets in the last `catchUpHours`.
   */
  async runOnce(): Promise<{ hoursProcessed: number; docsWritten: number }> {
    if (this.running) return { hoursProcessed: 0, docsWritten: 0 }
    this.running = true

    const t0 = performance.now()
    try {
      const now = new Date()
      const currentHour = truncateToHourUTC(now)
      // Process closed hours only once `offsetMin` has passed after their end
      // (BIL-2: the option was declared but never read, so an hour could be
      // rolled up seconds after it closed, before its last sessions landed).
      const start = new Date(currentHour.getTime() - this.opts.catchUpHours * 3_600_000)
      const buckets = enumerateHourBuckets(start, rollupCutoff(now, this.opts.offsetMin))

      let hoursProcessed = 0
      let docsWritten = 0

      for (const bucket of buckets) {
        // Skip only if THIS hour has a completion marker (A1.2). We deliberately
        // do NOT gate on "a rollup doc exists for the hour": a demo-seed rollup
        // or a half-written hour (agent rollups persisted, then a crash) would
        // both satisfy that and skip the hour forever, silently dropping the real
        // sessions in it. The marker is written only after both persist phases
        // succeed with real data, and never by the seed. Upserts are idempotent,
        // so an unmarked-but-partially-rolled hour is safely re-run to completion.
        if (await this.hourCompleted(bucket)) continue

        try {
          const written = await this.processHour(bucket)
          hoursProcessed++
          docsWritten += written
        } catch (err) {
          this.rollup_errors++
          this.log.error({ err, hourBucket: bucket }, "agent-usage-rollup-job: hour failed")
        }
        // Yield to the event loop between buckets
        await new Promise<void>((r) => setImmediate(r))
      }

      this.rollup_docs_written += docsWritten
      this.rollup_lag_hours = computeLagHours(currentHour, await this.latestRollupBucket())
      this.rollup_last_run_at = Date.now()
      return { hoursProcessed, docsWritten }
    } finally {
      this.rollup_job_duration_ms = Math.round(performance.now() - t0)
      this.running = false
    }
  }

  /**
   * Compute and upsert rollups for a specific closed hour bucket.
   *
   * Split Phase orchestrator (R2.2):
   *   1. `collectHourAggregates` — cursor stream + accumulate.
   *   2. `persistAgentRollups`   — upsert agent_usage_rollups_hourly.
   *   3. `persistUserRollups`    — upsert agent_usage_rollups_user_hourly.
   *
   * Exported for testing and manual rebuilds.
   */
  async processHour(hourBucket: Date): Promise<number> {
    const hourEnd = new Date(hourBucket.getTime() + 3_600_000)
    const jobRunId = generateUsageRollupId()
    const computedAt = new Date()

    const aggregates = await this.collectHourAggregates(hourBucket, hourEnd)

    const agent = await this.persistAgentRollups(
      aggregates.perAgent,
      hourBucket,
      computedAt,
      jobRunId,
    )
    const user = await this.persistUserRollups(
      aggregates.perUserIntervals,
      aggregates.perUserTotals,
      aggregates.perUserWorkMs,
      hourBucket,
      computedAt,
      jobRunId,
    )

    // Mark the hour complete only when its numbers are final (BIL-2):
    //   - no recent session overlapping the hour is still open — it will add
    //     time to this hour when it closes, and the tracker must not bill the
    //     hour before that (it never revisits a billed hour);
    //   - every upsert landed — a failed write used to be swallowed and the
    //     hour marked anyway, losing that user's time for good.
    // Empty hours are marked too: the tracker bills only up to the first
    // unmarked hour, so a gap would stall billing (and every tick re-scanned
    // them). A late session for an empty hour is what the open-session guard
    // and the offsetMin grace are for.
    if (aggregates.openSessions === 0 && agent.errors + user.errors === 0) {
      await this.markHourComplete(hourBucket, jobRunId, agent.written, user.written)
    } else {
      this.log.info(
        { hourBucket, openSessions: aggregates.openSessions, errors: agent.errors + user.errors },
        "agent-usage-rollup-job: hour not final yet, left unmarked",
      )
    }

    return agent.written + user.written
  }

  /**
   * Compute (WITHOUT persisting) the per-user billed-time metrics for one hour
   * bucket — the same non-billable guard + interval clamp the persisted rollups
   * use, summed across workspaces so the key is the bare userId (how the
   * tracker/reconciler aggregate a user's billed hours).
   *
   * Read-only sibling of `processHour`, used by the phantom-billing remediation
   * (TER-652) and the unbilled-hours estimate to measure the correction in
   * dry-run and verify it on apply, sharing this job's exact aggregation logic
   * instead of reimplementing it.
   *
   * @param metric 'work' → sum of per-session overlaps (decision #29, what the
   *               tracker bills); 'active' → coalesced union (decision #26,
   *               legacy/analytical). Defaults to 'work' — every billing reader
   *               must use the same one or the canary sings eternal drift.
   */
  async computeUserBilledMsForHour(
    hourBucket: Date,
    metric: "work" | "active" = "work",
  ): Promise<Map<string, number>> {
    const hourEnd = new Date(hourBucket.getTime() + 3_600_000)
    const { perUserIntervals, perUserWorkMs } = await this.collectHourAggregates(hourBucket, hourEnd)
    const byUser = new Map<string, number>()
    for (const [userKey, intervals] of perUserIntervals) {
      const [userId] = userKey.split("|")
      const ms = metric === "work" ? (perUserWorkMs.get(userKey) ?? 0) : unionOfIntervalsMs(intervals)
      byUser.set(userId, (byUser.get(userId) ?? 0) + ms)
    }
    return byUser
  }

  /**
   * Compute the coalesced `userActiveMs` per user for one hour bucket.
   * Legacy alias of `computeUserBilledMsForHour(bucket, 'active')` kept for
   * callers that specifically want the union metric (analytics).
   */
  async computeUserActiveMsForHour(hourBucket: Date): Promise<Map<string, number>> {
    return this.computeUserBilledMsForHour(hourBucket, "active")
  }

  /**
   * True when `hourBucket` already has a completion marker. Gates `runOnce`.
   */
  private async hourCompleted(hourBucket: Date): Promise<boolean> {
    const marker = await this.runsCol.findOne({ hourBucket }, { projection: { _id: 1 } })
    return marker !== null
  }

  /**
   * Upsert the per-hour completion marker. Upsert (not insert) so a reprocessed
   * hour refreshes its marker rather than colliding on the unique `hourBucket`
   * index. Exported behavior tested via `runOnce`.
   */
  private async markHourComplete(
    hourBucket: Date,
    jobRunId: string,
    agentDocsWritten: number,
    userDocsWritten: number,
  ): Promise<void> {
    const marker: AgentUsageRollupRun = {
      hourBucket,
      completedAt: new Date(),
      jobRunId,
      agentDocsWritten,
      userDocsWritten,
      // 2 = user_hourly docs of this hour carry userWorkMs (decision #29).
      schemaVersion: 2,
    }
    await this.runsCol.updateOne({ hourBucket }, { $set: marker }, { upsert: true })
  }

  /**
   * Phase 1 — stream sessions that overlap with `[hourBucket, hourEnd)` and
   * accumulate them into the two in-memory maps used by the persistence
   * phases. Pure with respect to writes: no Mongo mutations here, only
   * reads.
   */
  private async collectHourAggregates(hourBucket: Date, hourEnd: Date): Promise<HourAggregates> {
    const overlapFilter = {
      startedAt: { $lt: hourEnd },
      $or: [{ endedAt: null }, { endedAt: { $gt: hourBucket } }],
      // Never fold demo-seed sessions into REAL rollups (A1.2). Without this the
      // rollup job would recompute the seed's fabricated turns as production data.
      ...EXCLUDE_DEMO_SEED,
    }

    const perAgent = new Map<string, RollupAccumulator>()
    const perUserIntervals = new Map<string, Interval[]>()
    const perUserTotals = new Map<string, UserAggregate>()
    // Sum of per-session overlaps per userKey — the billed quota metric
    // (decision #29). Unlike `perUserIntervals` this is NOT coalesced: two
    // parallel agents working the same minutes each contribute their work.
    const perUserWorkMs = new Map<string, number>()
    let openSessions = 0
    // Sessions open longer than this are presumed zombies the reconciler failed
    // to close; they must not hold the hour (and with it all billing) forever.
    const openSince = Date.now() - OPEN_SESSION_BLOCK_MAX_MS

    const cursor = this.sessionsCol.find(overlapFilter)
    try {
      for await (const session of cursor) {
        // A session with no execution anchor never ran (still `queued`, or
        // closed straight from queued) — it has no billable interval (TER-650/G1).
        // The overlap filter already excludes null startedAt; this also narrows
        // the type from `Date | null` to `Date` for the arithmetic below.
        if (!session.startedAt) continue
        if (!session.endedAt) {
          // Excluded per cutoff policy, but it keeps the hour from being final
          if (session.startedAt.getTime() >= openSince) openSessions++
          continue
        }
        // Sessions that did no real LLM work never bill agent-hours (TER-650).
        // Keeps reconciler zombies and failed 0-token turns out of BOTH the
        // per-agent and per-user (billed) aggregates.
        if (isNonBillableSession(session)) continue

        const start = session.startedAt < hourBucket ? hourBucket : session.startedAt
        const end = session.endedAt > hourEnd ? hourEnd : session.endedAt
        const overlapMs = Math.max(0, end.getTime() - start.getTime())
        if (overlapMs === 0) continue

        const totalMs = Math.max(1, session.endedAt.getTime() - session.startedAt.getTime())
        const fraction = overlapMs / totalMs

        this.accumulateAgent(perAgent, session, fraction, overlapMs)
        this.accumulateUser(
          perUserIntervals,
          perUserTotals,
          perUserWorkMs,
          session,
          fraction,
          overlapMs,
          start.getTime(),
          end.getTime(),
        )
      }
    } finally {
      await cursor.close()
    }

    return { perAgent, perUserIntervals, perUserTotals, perUserWorkMs, openSessions }
  }

  private accumulateAgent(
    perAgent: Map<string, RollupAccumulator>,
    session: AgentUsageSession,
    fraction: number,
    overlapMs: number,
  ): void {
    const groupKey = AgentRollupGroupKey.fromSession(session).toString()
    let agg = perAgent.get(groupKey)
    if (!agg) {
      agg = RollupAccumulator.fromSession(session)
      perAgent.set(groupKey, agg)
    }
    agg.add(session, fraction, overlapMs)
  }

  private accumulateUser(
    perUserIntervals: Map<string, Interval[]>,
    perUserTotals: Map<string, UserAggregate>,
    perUserWorkMs: Map<string, number>,
    session: AgentUsageSession,
    fraction: number,
    overlapMs: number,
    startMs: number,
    endMs: number,
  ): void {
    const userKey = `${session.userId}|${session.workspaceId}`
    const intervals = perUserIntervals.get(userKey) ?? []
    intervals.push({ start: startMs, end: endMs })
    perUserIntervals.set(userKey, intervals)

    // Billed work metric (decision #29): SUM of per-session overlaps — each
    // parallel agent's time counts, no coalescing.
    perUserWorkMs.set(userKey, (perUserWorkMs.get(userKey) ?? 0) + overlapMs)

    const userTotal = perUserTotals.get(userKey) ?? {
      totalTokens: 0,
      costUsd: 0,
      sessionCount: 0,
      workspaceId: session.workspaceId,
    }
    userTotal.totalTokens += Math.round(session.totalTokens * fraction)
    userTotal.costUsd += session.costUsd * fraction
    userTotal.sessionCount += 1
    perUserTotals.set(userKey, userTotal)
  }

  /**
   * Phase 2 — upsert one `agent_usage_rollups_hourly` doc per agent bucket.
   */
  private async persistAgentRollups(
    perAgent: Map<string, RollupAccumulator>,
    hourBucket: Date,
    computedAt: Date,
    jobRunId: string,
  ): Promise<{ written: number; errors: number }> {
    let docsWritten = 0
    let errors = 0
    for (const [, agg] of perAgent) {
      const doc = agg.toDoc({
        rollupId: generateUsageRollupId(),
        hourBucket,
        computedAt,
        jobRunId,
      })
      try {
        await this.hourlyCol.updateOne(
          {
            hourBucket,
            "groupKey.userId": agg.groupKey.userId,
            "groupKey.agentId": agg.groupKey.agentId,
            "groupKey.provider": agg.groupKey.provider,
            "groupKey.workspaceId": agg.groupKey.workspaceId,
          },
          { $set: doc },
          { upsert: true },
        )
        docsWritten++
      } catch (err) {
        errors++
        this.rollup_errors++
        this.log.error({ err, hourBucket }, "agent-usage-rollup-job: hourly upsert failed")
      }
    }
    return { written: docsWritten, errors }
  }

  /**
   * Phase 3 — upsert one `agent_usage_rollups_user_hourly` doc per user
   * bucket. `userActiveMs` is the union of session intervals coalesced in
   * JS by `unionOfIntervalsMs` (decision #26, analytical). `userWorkMs` is
   * the SUM of per-session overlaps (decision #29) — the metric the agent-hours
   * tracker bills: parallel agents each burn quota.
   */
  private async persistUserRollups(
    perUserIntervals: Map<string, Interval[]>,
    perUserTotals: Map<string, UserAggregate>,
    perUserWorkMs: Map<string, number>,
    hourBucket: Date,
    computedAt: Date,
    jobRunId: string,
  ): Promise<{ written: number; errors: number }> {
    let docsWritten = 0
    let errors = 0
    for (const [userKey, intervals] of perUserIntervals) {
      const [userId] = userKey.split("|")
      const totals = perUserTotals.get(userKey)
      if (!totals) continue

      const doc: AgentUsageRollupUserHourly = {
        rollupId: generateUsageRollupId(),
        hourBucket,
        groupKey: { userId, workspaceId: totals.workspaceId },
        userActiveMs: unionOfIntervalsMs(intervals),
        userWorkMs: perUserWorkMs.get(userKey) ?? 0,
        sessionCount: totals.sessionCount,
        totalTokens: totals.totalTokens,
        costUsd: totals.costUsd,
        computedAt,
        jobRunId,
        schemaVersion: 2,
        createdAt: computedAt,
      }

      try {
        await this.userHourlyCol.updateOne(
          {
            hourBucket,
            "groupKey.userId": userId,
            "groupKey.workspaceId": totals.workspaceId,
          },
          { $set: doc },
          { upsert: true },
        )
        docsWritten++
      } catch (err) {
        errors++
        this.rollup_errors++
        this.log.error({ err, hourBucket }, "agent-usage-rollup-job: user_hourly upsert failed")
      }
    }
    return { written: docsWritten, errors }
  }

  private async latestRollupBucket(): Promise<Date | null> {
    const latest = await this.hourlyCol.findOne(
      {},
      { sort: { hourBucket: -1 }, projection: { hourBucket: 1 } },
    )
    return latest?.hourBucket ?? null
  }
}

// ============================================================================
// Helpers (exported for testing)
// ============================================================================

export interface Interval {
  start: number
  end: number
}

interface UserAggregate {
  totalTokens: number
  costUsd: number
  sessionCount: number
  workspaceId: string
}

interface HourAggregates {
  perAgent: Map<string, RollupAccumulator>
  perUserIntervals: Map<string, Interval[]>
  perUserTotals: Map<string, UserAggregate>
  /** Sum of per-session overlaps per userKey — the billed quota metric (decision #29). */
  perUserWorkMs: Map<string, number>
  /** Recent sessions overlapping the hour that are still open (not rolled yet). */
  openSessions: number
}

/**
 * An open session older than this no longer holds its hours back from
 * completion. The reconciler closes sessions after 15 min, so a real one never
 * gets near it; it bounds the damage if the reconciler stops.
 */
export const OPEN_SESSION_BLOCK_MAX_MS = 2 * 3_600_000

/**
 * The hour (exclusive) up to which closed hours may be rolled up at `now`:
 * an hour is eligible once `offsetMin` minutes have passed after its end.
 */
export function rollupCutoff(now: Date, offsetMin: number): Date {
  return truncateToHourUTC(new Date(now.getTime() - offsetMin * 60_000))
}

/**
 * The hour (exclusive) up to which agent-hours may be billed (BIL-3).
 *
 * The tracker bills rollups with `hourBucket > cursor` and then moves the
 * cursor to the newest billed hour, never looking back. So it must only see
 * hours whose rollups are final: everything before the first hour, within the
 * rollup catch-up window, that has no completion marker. A failed or
 * still-open hour now holds the cursor back instead of being skipped forever.
 */
export async function computeBillableHorizon(
  db: Db,
  now: Date,
  opts: Pick<RollupJobOptions, "offsetMin" | "catchUpHours"> = DEFAULT_ROLLUP_OPTS,
): Promise<Date> {
  const cutoff = rollupCutoff(now, opts.offsetMin)
  const start = new Date(truncateToHourUTC(now).getTime() - opts.catchUpHours * 3_600_000)
  const markers = await db
    .collection<AgentUsageRollupRun>("agent_usage_rollup_runs")
    .find({ hourBucket: { $gte: start, $lt: cutoff } }, { projection: { hourBucket: 1 } })
    .toArray()
  const completed = new Set(markers.map((m) => m.hourBucket.getTime()))
  for (const bucket of enumerateHourBuckets(start, cutoff)) {
    if (!completed.has(bucket.getTime())) return bucket
  }
  return cutoff
}

/**
 * Sort intervals by start and coalesce overlapping ones. Returns total
 * milliseconds covered (never exceeds the input span). Pure function used by
 * the rollup job and the rebuild script.
 */
export function unionOfIntervalsMs(intervals: Interval[]): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  let total = 0
  let curStart = sorted[0].start
  let curEnd = sorted[0].end
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]
    if (next.start <= curEnd) {
      if (next.end > curEnd) curEnd = next.end
    } else {
      total += curEnd - curStart
      curStart = next.start
      curEnd = next.end
    }
  }
  total += curEnd - curStart
  return Math.max(0, total)
}

/**
 * A session that represents no real LLM work must not bill agent-hours. Two
 * cases:
 *   1. Zombies closed by the reconciler (`errorKind === 'reconciled_timeout'`):
 *      the turn hung and never produced anything; the reconciler stamped a full
 *      wall-clock `durationMs` on it. Always non-billable.
 *   2. Any failed session that consumed zero tokens (`errored`/`timed_out`/
 *      `aborted` with `totalTokens === 0`): the LLM produced nothing.
 *
 * A `completed` session with 0 tokens STILL bills (it ran to a clean end). A
 * failed session with `totalTokens > 0` STILL bills (real work was cut short).
 * Excluding these from `collectHourAggregates` keeps them out of both the
 * per-agent analytics and the per-user (billed) `userActiveMs`.
 *
 * Root cause of the phantom-session billing incident (TER-650): a hung LLM call
 * left a `running` session that the reconciler later closed as `timed_out` with
 * full wall-clock duration, which the rollup then billed as ~0.325h of work that
 * never happened. This guard makes that impossible by construction, independent
 * of WHY the call hung.
 */
export function isNonBillableSession(
  s: Pick<AgentUsageSession, "status" | "errorKind" | "totalTokens">,
): boolean {
  if (s.errorKind === "reconciled_timeout") return true
  if (
    s.totalTokens === 0 &&
    (s.status === "errored" || s.status === "timed_out" || s.status === "aborted")
  ) {
    return true
  }
  return false
}

/**
 * Truncate a date to the start of the hour in UTC.
 */
export function truncateToHourUTC(date: Date): Date {
  const d = new Date(date)
  d.setUTCMinutes(0, 0, 0)
  return d
}

/**
 * Enumerate hour buckets in `[start, end)` (UTC, hourly aligned).
 */
export function enumerateHourBuckets(start: Date, end: Date): Date[] {
  const buckets: Date[] = []
  let cur = truncateToHourUTC(start)
  const stop = truncateToHourUTC(end)
  while (cur < stop) {
    buckets.push(cur)
    cur = new Date(cur.getTime() + 3_600_000)
  }
  return buckets
}

/**
 * Compute the rollup lag in hours.
 *
 * Returns `Number.POSITIVE_INFINITY` when no rollups exist yet (e.g. fresh
 * install). Callers — including the Prometheus exposition — must treat
 * `+Inf` as "no data" rather than a literal time delta. The `/metrics`
 * endpoint normalises non-finite values to `0` so Prometheus accepts the
 * scrape; the alarm logic in `agent-usage-sentry-alerts.ts` thresholds on
 * a numeric ceiling so `+Inf` does NOT trigger spurious alerts on first
 * boot.
 *
 * Exported for tests.
 */
export function computeLagHours(currentHour: Date, latest: Date | null): number {
  if (!latest) return Number.POSITIVE_INFINITY
  const diffMs = currentHour.getTime() - latest.getTime()
  return Math.max(0, Math.round(diffMs / 3_600_000) - 1)
}
