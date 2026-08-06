/**
 * Distributed leader election backed by MongoDB.
 *
 * Why this exists:
 *   The agent usage instrumentation has three background jobs that MUST run
 *   on exactly one instance at any given time:
 *     - agent-usage-reconciler (closes orphan sessions every 5 min)
 *     - agent-usage-rollup-job (computes hourly rollups every 5 min)
 *     - agent-usage-sentry-alerts (polls metrics and emits warnings)
 *
 *   When Teros runs in multi-instance mode (PM2 cluster or N pods), every
 *   instance would otherwise execute its own setInterval and we'd see:
 *     - Wasted compute (same buckets processed N times).
 *     - Subtle races (rollup vs reconciler on the same docs concurrently
 *       across instances; idempotent filter saves correctness but burns CPU).
 *     - Duplicate Sentry events for the same incident, multiplied by N.
 *
 * Design:
 *   - One row per logical lock in `leader_locks` keyed by `name` (PK).
 *   - Acquisition is "compare-and-swap" via `findOneAndUpdate` with a filter
 *     that matches only when the lock is free (expired) OR already owned by
 *     us. Upsert handles the empty case atomically.
 *   - The owner refreshes its TTL via heartbeat. Without heartbeat the lock
 *     expires naturally and another instance can claim it next tick.
 *   - TTL index on `expiresAt` cleans up dead-owner rows from the DB so the
 *     collection stays bounded.
 *
 * Failure modes covered:
 *   - Owner crashes mid-tick: lock expires after `ttlMs`; next tick of any
 *     instance can re-acquire. Jobs are idempotent per the design doc.
 *   - Clock skew across instances: only the lock owner writes to a doc
 *     keyed by `name`; the unique index forbids two concurrent owners.
 *     The TTL is wall-clock but tolerates skew up to `ttlMs / 2` safely.
 *   - Heartbeat fails (DB blip): the lock expires; another instance takes
 *     over. The previous owner notices on next acquire attempt and adopts
 *     "not leader" semantics until it wins again.
 *   - Multiple instances start simultaneously: only one wins the upsert;
 *     the others see `tryAcquire === false` and skip the tick.
 *
 *
 */

import type { Collection, Db } from "mongodb"
import { isMongoDuplicateKey } from "../lib/mongo-errors.js"

export interface LeaderLockDocument {
  /** Logical lock name (PK). Examples: "agent-usage-reconciler", "agent-usage-rollup-job". */
  name: string
  /** Identifier of the instance that currently owns the lock. */
  ownerId: string
  /** When the lock was first acquired by the current owner. */
  acquiredAt: Date
  /**
   * Wall-clock expiration. The TTL index uses this field to clean up dead
   * rows; the application logic uses it for compare-and-swap.
   */
  expiresAt: Date
}

export interface LeaderElectionOptions {
  /**
   * Default lock duration. Should be ~ 2× the expected tick duration so that
   * a slow tick does not lose the lock to another instance mid-run.
   */
  ttlMs: number
}

export const DEFAULT_LEADER_OPTS: LeaderElectionOptions = {
  ttlMs: 60_000,
}

export class LeaderElectionService {
  private col: Collection<LeaderLockDocument>

  constructor(
    private readonly db: Db,
    private readonly ownerId: string,
    public readonly opts: LeaderElectionOptions = DEFAULT_LEADER_OPTS,
  ) {
    this.col = db.collection<LeaderLockDocument>("leader_locks")
  }

  /**
   * The instance id used for ownership. Exposed so background jobs and the
   * /metrics endpoint can include it as a label.
   */
  getOwnerId(): string {
    return this.ownerId
  }

  /**
   * Try to acquire the lock named `name`.
   *
   * Returns true if this instance now holds the lock (either because the
   * previous owner expired, we already owned it, or no one did). Returns
   * false if another instance currently holds a non-expired lock.
   *
   * `ttlMs` overrides the default lock duration for this specific job.
   */
  async tryAcquire(name: string, ttlMs: number = this.opts.ttlMs): Promise<boolean> {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + ttlMs)

    try {
      // Atomic CAS: only update when the lock is free OR already ours.
      const result = await this.col.findOneAndUpdate(
        {
          name,
          $or: [{ expiresAt: { $lt: now } }, { ownerId: this.ownerId }],
        },
        {
          $set: { ownerId: this.ownerId, expiresAt },
          $setOnInsert: { acquiredAt: now },
        },
        { upsert: true, returnDocument: "after" },
      )
      // After the upsert, `ownerId` must equal ours for us to be the leader.
      return result?.ownerId === this.ownerId
    } catch (err) {
      // E11000 duplicate key happens when two upserts race; the loser must
      // re-read to confirm. We re-check via a plain query.
      if (isMongoDuplicateKey(err)) {
        const fresh = await this.col.findOne({ name })
        return fresh?.ownerId === this.ownerId && fresh.expiresAt > now
      }
      throw err
    }
  }

  /**
   * Refresh the TTL of a lock we already own. Returns true if the heartbeat
   * succeeded (we still own the lock); false otherwise (someone else took
   * over while we slept).
   */
  async heartbeat(name: string, ttlMs: number = this.opts.ttlMs): Promise<boolean> {
    const now = new Date()
    const expiresAt = new Date(now.getTime() + ttlMs)
    const result = await this.col.updateOne(
      { name, ownerId: this.ownerId },
      { $set: { expiresAt } },
    )
    return result.matchedCount > 0
  }

  /**
   * Release the lock if we own it. Safe to call when we don't (no-op).
   *
   * Most callers prefer to let the lock expire naturally; explicit release is
   * useful on graceful shutdown so the next instance can take over without
   * waiting `ttlMs` to recover.
   */
  async release(name: string): Promise<void> {
    await this.col.deleteOne({ name, ownerId: this.ownerId })
  }

  /**
   * Best-effort query: do we currently hold a non-expired lock named `name`?
   *
   * Read-only; does not affect the lock state.
   */
  async isLeader(name: string): Promise<boolean> {
    const now = new Date()
    const doc = await this.col.findOne({ name })
    return !!doc && doc.ownerId === this.ownerId && doc.expiresAt > now
  }
}

/**
 * Canonical lock names. Stored in a const so a typo in one job does not
 * silently break the coordination (TS will flag the divergence).
 */
export const LEADER_LOCKS = {
  ReconcileAgentUsage: "agent-usage-reconciler",
  RollupAgentUsage: "agent-usage-rollup-job",
  SentryAgentUsageAlerts: "agent-usage-sentry-alerts",
  // El tick del scheduler debe correr en UNA sola instancia. El atomic claim
  // por task/reminder cubre la ventana de fallover; este lock evita el trabajo
  // duplicado (y dispatches duplicados) en multi-instancia en el caso normal.
  Scheduler: "scheduler-tick",
  AgentHoursTracker: "agent-hours-tracker",
  BillingResetCron: "billing-reset-cron",
  BillingReconciliation: "billing-reconciliation-daily",
  BillingChargeCron: "billing-charge-cron",
} as const

export type LeaderLockName = (typeof LEADER_LOCKS)[keyof typeof LEADER_LOCKS]
