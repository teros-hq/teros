/**
 * Reconciler for orphaned agent usage sessions and tool executions.
 *
 * Runs in the main process via setInterval (decision #11: single PM2 worker).
 * Closes documents in status='running' whose startedAt is older than the
 * stale threshold. Writes directly to projections to avoid an emit→apply
 * loop with the buffer.
 *
 * Closes:
 *   - agent_usage_sessions → status='timed_out', errorKind='reconciled_timeout',
 *     durationSource='wallclock_reconciled', durationMs = now - startedAt
 *   - tool_executions → idem
 *
 * Idempotent via filter `{status:'running'}`.
 *
 *
 */

import type { Logger } from "pino"
import type { AgentUsageSessionRepository } from "./agent-usage-session-repository.js"
import type { LeaderElectionService } from "./leader-election.js"
import { LEADER_LOCKS } from "./leader-election.js"
import type { ToolExecutionRepository } from "./tool-execution-repository.js"

export interface ReconcilerOptions {
  /** Minutes after startedAt to consider a running doc stale. */
  staleThresholdMin: number
  /** How often the reconciler runs. */
  intervalMs: number
  /**
   * Lease duration when acquiring the distributed leader lock. Must be ≥ 2×
   * the worst expected tick duration so a slow tick does not lose the lock
   * mid-run.
   */
  leaderLockTtlMs: number
}

export const DEFAULT_RECONCILER_OPTS: ReconcilerOptions = {
  staleThresholdMin: 15,
  intervalMs: 5 * 60 * 1000,
  // Reconciler ticks are usually < 5s; 60s gives ample headroom and lets
  // another instance take over within 1 min if the holder dies.
  leaderLockTtlMs: 60_000,
}

/**
 * Max stale docs closed per tick (per collection). Caps a pathological backlog
 * so one tick can't load unbounded docs; the next tick (every 5 min) picks up
 * the rest — each close flips the doc out of `running`, so progress is
 * guaranteed. When a tick hits this cap we log + count it: a saturated batch is
 * a signal that turns are hanging en masse (the phantom-session class, TER-650)
 * that would otherwise stay silent behind the bounded query.
 */
export const RECONCILE_BATCH_LIMIT = 1000

export interface ReconcilerMetrics {
  reconcile_sessions_closed: number
  reconcile_tools_closed: number
  reconcile_errors: number
  reconcile_last_run_at: number | null
  /** Ticks where the leader lock was held by another instance (we skipped). */
  reconcile_skipped_not_leader: number
  /**
   * Times a reconcile batch hit RECONCILE_BATCH_LIMIT (per collection). A
   * non-zero, growing value means turns are hanging faster than one tick can
   * close them — a backlog that would otherwise be invisible behind the bounded
   * query. TER-650.
   */
  reconcile_batch_saturated: number
}

export class AgentUsageReconciler {
  private timer: NodeJS.Timeout | null = null
  private running = false

  // Metrics
  private reconcile_sessions_closed = 0
  private reconcile_tools_closed = 0
  private reconcile_errors = 0
  private reconcile_last_run_at: number | null = null
  private reconcile_skipped_not_leader = 0
  private reconcile_batch_saturated = 0

  constructor(
    private readonly sessions: AgentUsageSessionRepository,
    private readonly tools: ToolExecutionRepository,
    private readonly log: Logger,
    /**
     * Optional. When provided, the periodic `start()` tick only runs if the
     * distributed lock is acquired by this instance. Multi-instance safe.
     * When null, ticks run unconditionally (single-instance / tests).
     */
    private readonly leader: LeaderElectionService | null = null,
    public readonly opts: ReconcilerOptions = DEFAULT_RECONCILER_OPTS,
  ) {}

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.log.error({ err }, "agent-usage-reconciler: tick failed")
      })
    }, this.opts.intervalMs)
    if (typeof this.timer.unref === "function") this.timer.unref()
  }

  /**
   * One scheduled tick: acquire the leader lock (no-op if null) and run.
   * Separate from `runOnce` so tests can drive the work without touching
   * the lock.
   */
  private async tick(): Promise<void> {
    if (this.leader) {
      const acquired = await this.leader.tryAcquire(
        LEADER_LOCKS.ReconcileAgentUsage,
        this.opts.leaderLockTtlMs,
      )
      if (!acquired) {
        this.reconcile_skipped_not_leader++
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

  getMetrics(): ReconcilerMetrics {
    return {
      reconcile_sessions_closed: this.reconcile_sessions_closed,
      reconcile_tools_closed: this.reconcile_tools_closed,
      reconcile_errors: this.reconcile_errors,
      reconcile_last_run_at: this.reconcile_last_run_at,
      reconcile_skipped_not_leader: this.reconcile_skipped_not_leader,
      reconcile_batch_saturated: this.reconcile_batch_saturated,
    }
  }

  /**
   * Public entry point. Useful for tests and manual triggers.
   */
  async runOnce(): Promise<{ sessionsClosed: number; toolsClosed: number }> {
    if (this.running) return { sessionsClosed: 0, toolsClosed: 0 }
    this.running = true
    try {
      const cutoff = new Date(Date.now() - this.opts.staleThresholdMin * 60_000)
      const [sessionsClosed, toolsClosed] = await Promise.all([
        this.reconcileSessions(cutoff),
        this.reconcileTools(cutoff),
      ])
      this.reconcile_last_run_at = Date.now()
      return { sessionsClosed, toolsClosed }
    } finally {
      this.running = false
    }
  }

  private async reconcileSessions(cutoff: Date): Promise<number> {
    // Two orphan classes, same cutoff (derived from the turn deadline + buffer,
    // TER-650/G1):
    //   - execution-orphan: `running` with startedAt < cutoff (driver died mid-turn).
    //   - queue-orphan:      `queued`  with createdAt < cutoff (worker never drained it).
    // Both close as `reconciled_timeout` (non-billable). A queue-orphan never
    // ran, so durationMs=0 and startedAt stays null.
    const execClosed = await this.closeOrphans(
      this.sessions.findStale(cutoff, RECONCILE_BATCH_LIMIT),
      "running",
      (doc, now) =>
        doc.startedAt ? Math.max(0, now.getTime() - doc.startedAt.getTime()) : 0,
      "execution",
    )
    const queueClosed = await this.closeOrphans(
      this.sessions.findStaleQueued(cutoff, RECONCILE_BATCH_LIMIT),
      "queued",
      () => 0,
      "queue",
    )
    const closed = execClosed + queueClosed
    this.reconcile_sessions_closed += closed
    return closed
  }

  /**
   * Close a bounded batch of orphaned sessions in `fromStatus`, guarded so a
   * concurrent clean close wins the race. `durationOf` derives the wall-clock
   * duration (0 for queue-orphans that never ran). Reports batch saturation.
   */
  private async closeOrphans(
    cursor: AsyncIterable<{ sessionUsageId: string; startedAt: Date | null }> & {
      close(): Promise<void>
    },
    fromStatus: "running" | "queued",
    durationOf: (doc: { startedAt: Date | null }, now: Date) => number,
    kind: "execution" | "queue",
  ): Promise<number> {
    let closed = 0
    let seen = 0
    try {
      for await (const doc of cursor) {
        seen++
        try {
          const now = new Date()
          const wrote = await this.sessions.update(
            doc.sessionUsageId,
            {
              $set: {
                status: "timed_out",
                errorKind: "reconciled_timeout",
                endedAt: now,
                durationMs: durationOf(doc, now),
                durationSource: "wallclock_reconciled",
                updatedAt: now,
              },
            },
            { status: fromStatus },
          )
          if (wrote) closed++
        } catch (err) {
          this.reconcile_errors++
          this.log.error(
            { err, sessionUsageId: doc.sessionUsageId, kind },
            "agent-usage-reconciler: session close failed",
          )
        }
      }
    } finally {
      await cursor.close()
    }
    if (seen >= RECONCILE_BATCH_LIMIT) {
      this.reconcile_batch_saturated++
      this.log.warn(
        { seen, closed, kind, limit: RECONCILE_BATCH_LIMIT },
        "agent-usage-reconciler: session batch hit the cap — a backlog remains, " +
          "the next tick will continue (turns may be hanging en masse; TER-650)",
      )
    }
    return closed
  }

  private async reconcileTools(cutoff: Date): Promise<number> {
    let closed = 0
    let seen = 0
    const cursor = this.tools.findStale(cutoff, RECONCILE_BATCH_LIMIT)
    try {
      for await (const doc of cursor) {
        seen++
        try {
          const now = new Date()
          const durationMs = Math.max(0, now.getTime() - doc.startedAt.getTime())
          const wrote = await this.tools.update(
            doc.toolExecutionId,
            {
              $set: {
                status: "aborted",
                endedAt: now,
                durationMs,
                durationSource: "wallclock_reconciled",
              },
            },
            { status: "running" },
          )
          if (wrote) closed++
        } catch (err) {
          this.reconcile_errors++
          this.log.error(
            { err, toolExecutionId: doc.toolExecutionId },
            "agent-usage-reconciler: tool close failed",
          )
        }
      }
    } finally {
      await cursor.close()
    }
    if (seen >= RECONCILE_BATCH_LIMIT) {
      this.reconcile_batch_saturated++
      this.log.warn(
        { seen, closed, limit: RECONCILE_BATCH_LIMIT },
        "agent-usage-reconciler: tool batch hit the cap — a backlog remains, " +
          "the next tick will continue (TER-650)",
      )
    }
    this.reconcile_tools_closed += closed
    return closed
  }
}
