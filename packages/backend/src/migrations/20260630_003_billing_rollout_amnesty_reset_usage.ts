import type { Db } from "mongodb"
import { getBillingSubscriptionsCollection } from "../models/billing.js"
import type { Migration } from "./types.js"

/**
 * One-time billing-rollout amnesty: zero the consumed agent-hours on every
 * ACTIVE subscription so nobody starts the enforced-billing era blocked.
 *
 * Context: with the gate now strict (TER-621) and the Starter quota enforced, a
 * user who had already consumed their hours before enforcement — or whose period
 * only renews in weeks — would be locked out of the Teros model until the next
 * billing-reset-cron renewal. This zeroes agentHoursUsed (+ overageHours + the
 * 80%-warning flag) so every active sub gets its full quota for the rest of its
 * CURRENT period. The renewal date is left untouched (decision Antonio,
 * 2026-06-30: reset the counter only, keep the period).
 *
 * Mirrors the reset-cron's normal-renewal $set MINUS the period advance, and —
 * critically — KEEPS lastBilledHourBucket: it is the monotonic high-water mark
 * the agent-hours-tracker resumes from. Unsetting it would send the tracker back
 * to epoch and re-sum up to ~2 years of TTL-retained rollups into the fresh
 * counter (the historical double-count the FASE 0 reset had). With the cursor
 * kept, future usage accrues from 0 with no re-inflation. The period anchor
 * (periodStartBucket) is likewise left as-is — the period itself is unchanged.
 *
 * Scope: status:'active' only — a paused/ended sub is already blocked by the gate
 * (NoActiveSubscriptionError), so zeroing its counter would not unblock it. The
 * `agentHoursUsed > 0` filter skips subs that are already clean.
 *
 * One-shot by design: the migration framework records it and does not re-run.
 */
const migration: Migration = {
  description:
    "Billing-rollout amnesty: zero agentHoursUsed on every active subscription " +
    "(keep the period + cursor) so no user starts blocked under the strict gate (TER-621).",

  async up(db: Db): Promise<void> {
    const subsCol = getBillingSubscriptionsCollection(db)
    const now = new Date()

    const res = await subsCol.updateMany(
      { status: "active", agentHoursUsed: { $gt: 0 } },
      {
        $set: {
          agentHoursUsed: 0,
          overageHours: 0,
          // Re-arm the 80% usage warning for the (kept) current period.
          warned80At: null,
          updatedAt: now,
        },
      },
    )

    console.log(
      `[Migration] Rollout amnesty: reset consumed hours on ${res.modifiedCount} active subscription(s) ` +
        "(period + lastBilledHourBucket preserved).",
    )
  },
}

export default migration
