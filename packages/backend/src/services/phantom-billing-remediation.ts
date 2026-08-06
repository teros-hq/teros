/**
 * One-off remediation for phantom-session over-billing (TER-652).
 *
 * Before the TER-650 fix, a hung turn the reconciler closed with full wall-clock
 * (or a failed 0-token turn) leaked its `userActiveMs` into the billed rollups
 * and, through the agent-hours tracker, into `agentHoursUsed` — quota users
 * never actually consumed. The reconciliation-cron only DETECTS drift, and the
 * phantom is baked identically into both the counter AND the historical rollups,
 * so it never self-heals. This service reverses the damage.
 *
 * Design — maximum reuse, minimum new logic:
 *   1. Find the hour buckets touched by phantom sessions (`isNonBillableSession`)
 *      since `since`.
 *   2. Per active subscription, over the buckets that fall inside its BILLED
 *      range `(periodStartBucket, lastBilledHourBucket]`, measure the phantom
 *      inflation as `stored userActiveMs − corrected userActiveMs`, where the
 *      corrected value comes from the rollup job's own read-only aggregation
 *      (`computeUserActiveMsForHour`, guard applied). This is a RELATIVE amount,
 *      so a concurrent tracker commit cannot skew it.
 *   3. Apply (when not dry-run): recompute those buckets' rollups via
 *      `processHour` (so the rollups stop containing the phantom), write an
 *      append-only corrective ledger entry, and `$inc(agentHoursUsed, -phantom)`
 *      floored at 0.
 *
 * Idempotent: after apply, stored == corrected → a re-run measures 0 → skips.
 * The corrective ledger entry (keyed by the epoch sentinel bucket, unique per
 * subscription) is a belt-and-braces second guard.
 *
 * MUST run AFTER the TER-650 fix is deployed — otherwise the bleeding continues
 * and the correction chases a moving target. Default mode is dry-run.
 */

import crypto from "node:crypto"
import type { Collection, Db } from "mongodb"
import type { Logger } from "pino"
import {
  type BillingHourLedgerEntry,
  type BillingSubscription,
  getBillingHourLedgerCollection,
  getBillingSubscriptionsCollection,
} from "../models/billing"
import type { AgentUsageRollupUserHourly, AgentUsageSession } from "../types/database"
import { AgentUsageRollupJob, truncateToHourUTC } from "./agent-usage-rollup-job"

const HOUR_MS = 3_600_000
/** Below this residual (1 second) a correction is float-noise — skip it. */
const MIN_CORRECTION_HOURS = 1 / 3600

/**
 * Ledger sentinel bucket for the single corrective entry per subscription. A
 * real tracker entry's `hourBucket` is always a recent real bucket, never the
 * epoch, so `(subscriptionId, epoch)` is a collision-free idempotency key under
 * the unique index that also guards normal tracker commits.
 */
const REMEDIATION_LEDGER_BUCKET = new Date(0)

export interface RemediationSubResult {
  subscriptionId: string
  userId: string
  agentHoursUsedBefore: number
  phantomHours: number
  agentHoursUsedAfter: number
  bucketsCorrected: number
  applied: boolean
}

export interface RemediationReport {
  dryRun: boolean
  since: Date
  affectedBuckets: number
  subsScanned: number
  subsCorrected: number
  totalHoursReturned: number
  perSub: RemediationSubResult[]
}

export class PhantomBillingRemediation {
  private sessionsCol: Collection<AgentUsageSession>
  private userRollupsCol: Collection<AgentUsageRollupUserHourly>
  private billingCol: Collection<BillingSubscription>
  private ledgerCol: Collection<BillingHourLedgerEntry>
  private rollupJob: AgentUsageRollupJob

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
  ) {
    this.sessionsCol = db.collection<AgentUsageSession>("agent_usage_sessions")
    this.userRollupsCol = db.collection<AgentUsageRollupUserHourly>(
      "agent_usage_rollups_user_hourly",
    )
    this.billingCol = getBillingSubscriptionsCollection(db)
    this.ledgerCol = getBillingHourLedgerCollection(db)
    this.rollupJob = new AgentUsageRollupJob(db, log)
  }

  async run(opts: { since: Date; dryRun?: boolean }): Promise<RemediationReport> {
    const { since } = opts
    const dryRun = opts.dryRun ?? true

    // 1. Distinct hour buckets each user's phantom sessions touched.
    const affectedByUser = await this.affectedBucketsByUser(since)
    const affectedBuckets = new Set<number>()
    for (const buckets of affectedByUser.values()) for (const b of buckets) affectedBuckets.add(b)

    // 2. Correct each active subscription over its billed range.
    const perSub: RemediationSubResult[] = []
    let subsScanned = 0
    let subsCorrected = 0
    let totalHoursReturned = 0

    const cursor = this.billingCol.find({ status: "active" })
    try {
      for await (const sub of cursor) {
        subsScanned++
        const userId = sub.userId
        const userBuckets = affectedByUser.get(userId)
        if (!userBuckets || userBuckets.size === 0) continue

        const cutoff = sub.lastBilledHourBucket ?? null
        if (!cutoff) continue // nothing billed yet for this sub
        const anchor = sub.periodStartBucket ?? sub.currentPeriodStart ?? new Date(0)

        // Buckets inside the billed range (anchor, cutoff]. Only these were ever
        // added to the current agentHoursUsed, so only these can over-bill it.
        const inRange = [...userBuckets]
          .map((ms) => new Date(ms))
          .filter((b) => b > anchor && b <= cutoff)
        if (inRange.length === 0) continue

        let phantomMs = 0
        let bucketsCorrected = 0
        for (const bucket of inRange) {
          const stored = await this.storedUserActiveMs(userId, bucket)
          const correctedMap = await this.rollupJob.computeUserActiveMsForHour(bucket)
          const corrected = correctedMap.get(userId) ?? 0
          const delta = stored - corrected
          if (delta > 0) {
            phantomMs += delta
            bucketsCorrected++
          }
        }

        const phantomHours = phantomMs / HOUR_MS
        const before = sub.agentHoursUsed ?? 0
        if (phantomHours < MIN_CORRECTION_HOURS) continue

        // Never drive the counter below zero (floors at expected>=0).
        const correction = Math.min(phantomHours, before)
        const after = before - correction

        if (!dryRun) {
          await this.applyCorrection(sub, inRange, correction, after)
        }

        subsCorrected++
        totalHoursReturned += correction
        perSub.push({
          subscriptionId: sub._id,
          userId,
          agentHoursUsedBefore: before,
          phantomHours: correction,
          agentHoursUsedAfter: after,
          bucketsCorrected,
          applied: !dryRun,
        })
        this.log.info(
          {
            subscriptionId: sub._id,
            userId,
            phantomHours: correction,
            before,
            after,
            bucketsCorrected,
            dryRun,
          },
          "phantom-billing-remediation: subscription correction",
        )
      }
    } finally {
      await cursor.close()
    }

    return {
      dryRun,
      since,
      affectedBuckets: affectedBuckets.size,
      subsScanned,
      subsCorrected,
      totalHoursReturned,
      perSub,
    }
  }

  /**
   * Persist the correction for one subscription: recompute the affected buckets'
   * rollups (so they no longer contain the phantom), write the append-only
   * corrective ledger entry, then `$inc` the counter down. Ledger-first, and the
   * unique `(subscriptionId, epoch)` key makes a re-run a no-op.
   */
  private async applyCorrection(
    sub: BillingSubscription,
    buckets: Date[],
    correctionHours: number,
    after: number,
  ): Promise<void> {
    // Recompute the rollups so future reconciliation matches (idempotent upsert).
    for (const bucket of buckets) {
      await this.rollupJob.processHour(bucket)
    }

    // Append-only corrective ledger entry (belt-and-braces idempotency guard).
    try {
      await this.ledgerCol.insertOne({
        _id: crypto.randomUUID(),
        subscriptionId: sub._id,
        userId: sub.userId,
        hourBucket: REMEDIATION_LEDGER_BUCKET,
        fromHourBucket: null,
        hoursAdded: -correctionHours,
        cumulative: after,
        rollupCount: buckets.length,
        rollupIds: [],
        trackerRunId: "phantom-remediation-ter652",
        createdAt: new Date(),
      })
    } catch (err) {
      // Already remediated (duplicate sentinel) — the counter was corrected in a
      // prior run; do NOT $inc again.
      if (isDuplicateKeyError(err)) {
        this.log.warn(
          { subscriptionId: sub._id },
          "phantom-billing-remediation: already remediated (idempotent skip)",
        )
        return
      }
      throw err
    }

    // Decrement the live counter. Guard on the current value so we never $inc a
    // sub that a concurrent reset just zeroed (it would go negative).
    await this.billingCol.updateOne(
      { _id: sub._id, agentHoursUsed: { $gte: correctionHours } },
      { $inc: { agentHoursUsed: -correctionHours }, $set: { updatedAt: new Date() } },
    )
  }

  /** Distinct hour buckets (as epoch ms) each user's phantom sessions overlap. */
  private async affectedBucketsByUser(since: Date): Promise<Map<string, Set<number>>> {
    const byUser = new Map<string, Set<number>>()
    const cursor = this.sessionsCol.find({
      startedAt: { $gte: since },
      endedAt: { $ne: null },
      $or: [
        { errorKind: "reconciled_timeout" },
        { status: { $in: ["errored", "timed_out", "aborted"] }, totalTokens: 0 },
      ],
    })
    try {
      for await (const s of cursor) {
        // A session with no execution anchor (queued-orphan) never billed —
        // it was excluded from the rollup by construction, so there is nothing
        // to remediate (TER-650/G1). The Mongo `$gte` filter already excludes
        // null; this also narrows the type for truncateToHourUTC below.
        if (!s.startedAt) continue
        if (!s.endedAt) continue
        let bucket = truncateToHourUTC(s.startedAt)
        const end = s.endedAt
        const set = byUser.get(s.userId) ?? new Set<number>()
        // Every hour bucket the session overlaps.
        while (bucket < end) {
          set.add(bucket.getTime())
          bucket = new Date(bucket.getTime() + HOUR_MS)
        }
        byUser.set(s.userId, set)
      }
    } finally {
      await cursor.close()
    }
    return byUser
  }

  /** Stored billed userActiveMs for (userId, bucket), summed across workspaces. */
  private async storedUserActiveMs(userId: string, bucket: Date): Promise<number> {
    const agg = (await this.userRollupsCol
      .aggregate([
        { $match: { "groupKey.userId": userId, hourBucket: bucket } },
        { $group: { _id: null, totalMs: { $sum: "$userActiveMs" } } },
      ])
      .toArray()) as Array<{ totalMs: number }>
    return agg[0]?.totalMs ?? 0
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000
}
