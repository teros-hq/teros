/**
 * Estimate agent-hours that were worked but never billed (BIL-2 / BIL-3).
 *
 * Before the billable horizon, an hour could be billed before its numbers
 * were final (sessions still open across it) or skipped by the tracker
 * cursor; billed hours are never revisited, so their missing time was lost.
 * For each hour bucket a subscription has already billed (≤ its
 * lastBilledHourBucket), this compares the stored user-hourly rollup with the
 * same aggregation recomputed now from the sessions. Read-only.
 */

import type { Db } from "mongodb"
import pino from "pino"
import { AgentUsageRollupJob, enumerateHourBuckets } from "./agent-usage-rollup-job.js"

const HOUR_MS = 3_600_000

export interface UnbilledHoursRow {
  userId: string
  unbilledHours: number
}

export async function estimateUnbilledHours(
  db: Db,
  since: Date,
  until: Date,
): Promise<UnbilledHoursRow[]> {
  const job = new AgentUsageRollupJob(db, pino({ level: "silent" }))
  const subs = await db
    .collection("billing_subscriptions")
    .find({ status: "active" }, { projection: { userId: 1, lastBilledHourBucket: 1 } })
    .toArray()
  const billedUntil = new Map(
    subs.map((s) => [s.userId as string, s.lastBilledHourBucket as Date | undefined]),
  )

  const missingMs = new Map<string, number>()
  for (const bucket of enumerateHourBuckets(since, until)) {
    // Same billed metric as the tracker (decision #29: userWorkMs, union fallback).
    const recomputed = await job.computeUserBilledMsForHour(bucket)
    for (const [userId, correctMs] of recomputed) {
      const cursor = billedUntil.get(userId)
      // Not billed yet: the tracker now bills it from final rollups
      if (!cursor || bucket > cursor) continue
      const stored = await db
        .collection("agent_usage_rollups_user_hourly")
        .aggregate([
          { $match: { hourBucket: bucket, "groupKey.userId": userId } },
          { $group: { _id: null, ms: { $sum: { $ifNull: ["$userWorkMs", "$userActiveMs"] } } } },
        ])
        .toArray()
      const delta = correctMs - ((stored[0]?.ms as number | undefined) ?? 0)
      if (delta > 0) missingMs.set(userId, (missingMs.get(userId) ?? 0) + delta)
    }
  }

  return [...missingMs.entries()]
    .map(([userId, ms]) => ({ userId, unbilledHours: Number((ms / HOUR_MS).toFixed(3)) }))
    .sort((a, b) => b.unbilledHours - a.unbilledHours)
}
