/**
 * Agent Hours Tracker
 *
 * Reads from agent_usage_rollups_user_hourly and accumulates
 * userActiveMs into billing_subscriptions.agentHoursUsed.
 *
 * Idempotent via lastBilledHourBucket on the subscription doc.
 * Only processes rollup hour buckets strictly greater than the
 * subscription's lastBilledHourBucket, so replays and retries
 * never double-count.
 *
 * Runs as a background job gated by leader election.
 *
 *
 */

import type { Collection, Db } from "mongodb"
import type { Logger } from "pino"
import { isMongoDuplicateKey } from "../lib/mongo-errors.js"
import { captureException } from "../lib/sentry.js"
import {
  LEDGER_MAX_ROLLUP_IDS,
  getActiveBoostHours,
  getBillingHourLedgerCollection,
  getBillingPlansCollection,
  getEffectiveLimit,
  type BillingHourLedgerEntry,
  type BillingPlan,
} from "../models/billing.js"
import { waitUntilIdle } from "../lib/drain.js"
import { LEADER_LOCKS, type LeaderElectionService } from "./leader-election.js"

/**
 * Narrow port for emitting the 80%-usage warning over WebSocket (decision #11).
 * Only the one method the tracker needs, so tests inject a spy and production
 * passes the PubSubService. Null = warnings disabled (no-op).
 */
export interface BillingEventPublisher {
  broadcastToUser(userId: string, event: Record<string, unknown>): void
}

/** Fraction of the effective limit at which the usage warning fires. */
export const USAGE_WARNING_THRESHOLD = 0.8

export interface AgentHoursTrackerOptions {
  /** How often to check for new rollups to bill (default: 5 min). */
  intervalMs: number
  /** Leader lock TTL (default: 60s). */
  leaderLockTtlMs: number
}

export const DEFAULT_TRACKER_OPTS: AgentHoursTrackerOptions = {
  intervalMs: 5 * 60 * 1000,
  leaderLockTtlMs: 60_000,
}

export interface AgentHoursTrackerMetrics {
  tracker_runs: number
  tracker_users_billed: number
  tracker_hours_added: number
  tracker_ledger_entries: number
  tracker_errors: number
  tracker_last_run_at: number | null
  tracker_skipped_not_leader: number
  tracker_warnings_emitted: number
}

export class AgentHoursTracker {
  private timer: NodeJS.Timeout | null = null
  private running = false

  // Metrics
  private tracker_runs = 0
  private tracker_users_billed = 0
  private tracker_hours_added = 0
  private tracker_ledger_entries = 0
  private tracker_errors = 0
  private tracker_last_run_at: number | null = null
  private tracker_skipped_not_leader = 0
  private tracker_warnings_emitted = 0

  private rollupsCol: Collection<any>
  private billingCol: Collection<any>
  private ledgerCol: Collection<BillingHourLedgerEntry>

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly leader: LeaderElectionService | null = null,
    public readonly opts: AgentHoursTrackerOptions = DEFAULT_TRACKER_OPTS,
    private readonly pubsub: BillingEventPublisher | null = null,
  ) {
    this.rollupsCol = db.collection("agent_usage_rollups_user_hourly")
    this.billingCol = db.collection("billing_subscriptions")
    this.ledgerCol = getBillingHourLedgerCollection(db)
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.log.error({ err }, "agent-hours-tracker: tick failed")
      })
    }, this.opts.intervalMs)
    if (typeof this.timer.unref === "function") this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Graceful shutdown: stop scheduling, wait for an in-flight tick to finish
   * (up to timeoutMs), then release the leader lock so another instance can take
   * over without waiting for the TTL. Returns false if a tick was still running
   * at the timeout (caller force-exits; the lock TTL covers the interrupted tick).
   */
  async drain(timeoutMs = 10_000): Promise<boolean> {
    this.stop()
    const idle = await waitUntilIdle(() => this.running, { timeoutMs })
    if (idle) await this.leader?.release(LEADER_LOCKS.AgentHoursTracker)
    return idle
  }

  getMetrics(): AgentHoursTrackerMetrics {
    return {
      tracker_runs: this.tracker_runs,
      tracker_users_billed: this.tracker_users_billed,
      tracker_hours_added: this.tracker_hours_added,
      tracker_ledger_entries: this.tracker_ledger_entries,
      tracker_errors: this.tracker_errors,
      tracker_last_run_at: this.tracker_last_run_at,
      tracker_skipped_not_leader: this.tracker_skipped_not_leader,
      tracker_warnings_emitted: this.tracker_warnings_emitted,
    }
  }

  /**
   * Public entry point for tests and manual triggers.
   *
   * `heartbeat` is injected by tick() when running under leader election: it
   * refreshes the lock mid-run so a long tick (many subscriptions) cannot
   * outlive its TTL and let a second instance start processing in parallel.
   * It returns false if we lost leadership, in which case the run aborts.
   * Tests and manual triggers pass no heartbeat and run to completion.
   */
  async runOnce(opts?: {
    heartbeat?: () => Promise<boolean>
  }): Promise<{ usersBilled: number; hoursAdded: number }> {
    if (this.running) return { usersBilled: 0, hoursAdded: 0 }
    this.running = true
    try {
      const result = await this.processAllSubscriptions(opts?.heartbeat)
      this.tracker_runs++
      this.tracker_last_run_at = Date.now()
      return result
    } finally {
      this.running = false
    }
  }

  private async tick(): Promise<void> {
    if (this.leader) {
      const acquired = await this.leader.tryAcquire(
        LEADER_LOCKS.AgentHoursTracker,
        this.opts.leaderLockTtlMs,
      )
      if (!acquired) {
        this.tracker_skipped_not_leader++
        return
      }
    }
    const leader = this.leader
    await this.runOnce({
      heartbeat: leader
        ? () => leader.heartbeat(LEADER_LOCKS.AgentHoursTracker, this.opts.leaderLockTtlMs)
        : undefined,
    })
  }

  /** Refresh the leader lock at most this often during a long tick. */
  private static readonly HEARTBEAT_EVERY_MS = 20_000

  private async processAllSubscriptions(
    heartbeat?: () => Promise<boolean>,
  ): Promise<{
    usersBilled: number
    hoursAdded: number
  }> {
    let usersBilled = 0
    let totalHoursAdded = 0

    // One id per run, stamped on every ledger entry written this tick so a
    // single run's commits can be grouped/audited together.
    const trackerRunId = crypto.randomUUID()

    // Bill each active subscription from ITS OWN cursor (lastBilledHourBucket).
    //
    // A single GLOBAL cutoff (min of all lastBilledHourBucket) double-counts:
    // a user whose activity is ahead of the laggiest subscription would get the
    // range [global_cutoff, their_own_cursor] — already billed in prior ticks —
    // re-summed on every run. Per-user cursors make the window exactly the set
    // of hours not yet billed for THAT subscription.
    //
    // NOTE: team members are billed individually. The team only groups
    // invoices, not hour pools.
    // Skip subs the reset-cron is mid-rewriting (resetting:true). Without this,
    // a $inc here could race the reset's period rollover — billing hours onto a
    // sub whose agentHoursUsed is about to be zeroed (lost) or onto the wrong
    // period. The reset claims/releases the flag atomically (mutual exclusion).
    const cursor = this.billingCol.find(
      { status: "active", resetting: { $ne: true } },
      {
        projection: {
          userId: 1,
          lastBilledHourBucket: 1,
          agentHoursUsed: 1,
          planId: 1,
          customAgentHoursLimit: 1,
          warned80At: 1,
          currentPeriodEnd: 1,
        },
      },
    )

    // Cache plans within a tick so the 80% check is O(distinct plans), not O(subs).
    const planCache = new Map<string, BillingPlan | null>()

    let lastBeat = Date.now()

    try {
      for await (const sub of cursor) {
        // Keep the leader lock alive during long runs; bail if we lost it.
        if (heartbeat && Date.now() - lastBeat > AgentHoursTracker.HEARTBEAT_EVERY_MS) {
          lastBeat = Date.now()
          const stillLeader = await heartbeat()
          if (!stillLeader) {
            this.log.warn("agent-hours-tracker: lost leadership mid-tick, aborting run")
            break
          }
        }

        const userId = sub.userId as string
        const userCutoff: Date = sub.lastBilledHourBucket ?? new Date(0)

        try {
          // Sum only this user's rollups strictly after their own cursor.
          const agg = (await this.rollupsCol
            .aggregate([
              { $match: { "groupKey.userId": userId, hourBucket: { $gt: userCutoff } } },
              {
                $group: {
                  _id: null,
                  totalMs: { $sum: "$userActiveMs" },
                  maxHourBucket: { $max: "$hourBucket" },
                  count: { $sum: 1 },
                  rollupIds: { $push: "$_id" },
                },
              },
            ])
            .toArray()) as Array<{
            totalMs: number
            maxHourBucket: Date
            count: number
            rollupIds: unknown[]
          }>

          const group = agg[0]
          if (!group || group.count === 0) continue

          const hours = group.totalMs / 3_600_000
          const newUsed = (sub.agentHoursUsed ?? 0) + hours

          // ── Append-only ledger entry, written BEFORE the $inc (FASE 2a) ─────
          // Idempotency lives in TWO complementary guards:
          //   1. The unique index (subscriptionId, hourBucket) rejects a re-run
          //      that tries to ledger the same committed range again.
          //   2. The $inc below keeps its own atomic cursor guard.
          // We deliberately DO NOT skip the $inc when the ledger insert is a
          // duplicate: the $inc guard is the idempotency authority for
          // agentHoursUsed. So a crash between this insert and the $inc is
          // self-healing — next tick the ledger already exists (duplicate, fall
          // through) and the $inc, still pending, lands. Net invariant: every
          // committed range has exactly one ledger entry AND agentHoursUsed
          // never under-counts.
          try {
            await this.ledgerCol.insertOne({
              _id: crypto.randomUUID(),
              subscriptionId: sub._id as string,
              userId,
              hourBucket: group.maxHourBucket,
              fromHourBucket: sub.lastBilledHourBucket ?? null,
              hoursAdded: hours,
              cumulative: newUsed,
              rollupCount: group.count,
              rollupIds: group.rollupIds.slice(0, LEDGER_MAX_ROLLUP_IDS).map(String),
              trackerRunId,
              createdAt: new Date(),
            })
            this.tracker_ledger_entries++
          } catch (err) {
            if (!isMongoDuplicateKey(err)) throw err
            // Range already ledgered by a prior run — fall through to the $inc,
            // whose guard makes it a no-op if it also already landed.
          }

          // Atomic guard: advance only if the persisted cursor is still behind
          // the max hour we are about to commit. Idempotent — a retry with the
          // same maxHourBucket sees $lt = false and skips. (Second line of
          // defense; leader election keeps this single-writer.)
          const result = await this.billingCol.updateOne(
            {
              userId,
              status: "active",
              // Re-check the reset claim at write time: it may have flipped
              // between the cursor read and now. The reset wins the race.
              resetting: { $ne: true },
              $or: [
                { lastBilledHourBucket: { $lt: group.maxHourBucket } },
                { lastBilledHourBucket: { $exists: false } },
              ],
            },
            {
              $inc: { agentHoursUsed: hours },
              $set: {
                lastBilledHourBucket: group.maxHourBucket,
                updatedAt: new Date(),
              },
            },
          )

          if (result.matchedCount > 0) {
            usersBilled++
            totalHoursAdded += hours
            this.tracker_users_billed++
            this.tracker_hours_added += hours

            this.log.debug(
              {
                userId,
                hoursAdded: hours,
                rollupsProcessed: group.count,
                fromHourBucket: userCutoff,
                maxHourBucket: group.maxHourBucket,
              },
              "agent-hours-tracker: billed user",
            )

            // Emit the 80%-usage warning once per period (decision #11), now
            // that this user's consumption just advanced.
            await this.maybeWarnAt80(sub, newUsed, planCache)
          }
        } catch (err) {
          this.tracker_errors++
          this.log.error({ err, userId }, "agent-hours-tracker: failed to bill user")
          // Report per-user billing failures (nota 21): the loop swallows them to
          // isolate one bad user, so without this they'd be invisible in prod.
          captureException(err, { scope: "billing/tracker_bill_user", userId }, { userId })
        }
      }
    } finally {
      await cursor.close()
    }

    return { usersBilled, hoursAdded: totalHoursAdded }
  }

  /**
   * Emit the 80%-consumption warning (decision #11) for a subscription that just
   * had hours billed, at most once per period. The threshold is computed against
   * the EFFECTIVE limit (base + active boosts), so a granted boost correctly
   * pushes the warning point higher. Idempotency lives in the atomic claim of
   * `warned80At`: only the update that flips it from unset emits, so a re-run or
   * a racing instance cannot double-notify. The reset-cron clears the flag on
   * renewal. No-op when warnings are disabled, the plan is unmetered/non-Teros,
   * or the user is still under the threshold.
   */
  private async maybeWarnAt80(
    sub: {
      _id: string
      userId: string
      planId?: string
      customAgentHoursLimit?: number | null
      warned80At?: Date | null
      currentPeriodEnd?: Date
    },
    newUsed: number,
    planCache: Map<string, BillingPlan | null>,
  ): Promise<void> {
    if (!this.pubsub) return // warnings disabled
    if (sub.warned80At) return // already warned this period
    if (!sub.planId) return

    let plan = planCache.get(sub.planId)
    if (plan === undefined) {
      plan = await getBillingPlansCollection(this.db).findOne({ _id: sub.planId })
      planCache.set(sub.planId, plan)
    }
    // Only metered Teros plans warn (Basic / BYOK is unmetered).
    if (!plan?.features.terosModel) return
    const baseLimit = getEffectiveLimit(
      { customAgentHoursLimit: sub.customAgentHoursLimit ?? null },
      plan,
    )
    if (baseLimit <= 0) return

    const now = new Date()
    const boostHours = await getActiveBoostHours(this.db, sub._id, now)
    const effectiveLimit = baseLimit + boostHours
    if (newUsed < USAGE_WARNING_THRESHOLD * effectiveLimit) return

    // Atomic claim: only the writer that flips warned80At from unset emits.
    const claim = await this.billingCol.updateOne(
      { _id: sub._id, $or: [{ warned80At: null }, { warned80At: { $exists: false } }] },
      { $set: { warned80At: now } },
    )
    if (claim.matchedCount === 0) return // another writer warned first

    this.pubsub.broadcastToUser(sub.userId, {
      type: "billing.usage-warning",
      userId: sub.userId,
      used: newUsed,
      limit: effectiveLimit,
      boostHours,
      threshold: USAGE_WARNING_THRESHOLD,
      tier: plan.name,
      planName: plan.displayName,
      periodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    })
    this.tracker_warnings_emitted++
    this.log.info(
      { userId: sub.userId, used: newUsed, limit: effectiveLimit },
      "agent-hours-tracker: 80% usage warning emitted",
    )
  }
}
