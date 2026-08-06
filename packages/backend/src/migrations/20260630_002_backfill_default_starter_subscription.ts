import type { Db } from "mongodb"
import { createDefaultSubscription, getBillingSubscriptionsCollection } from "../models/billing.js"
import type { Migration } from "./types.js"

/**
 * Backfill an active Starter subscription for every user that has NO active one.
 *
 * Context: TER-621 turned the billing gate strict — assertHoursAvailable now
 * throws NoActiveSubscriptionError when a user has no billing_subscription with
 * status:'active', instead of silently serving the Teros model unmetered. That
 * is correct for a paused/past_due account, but at the TER-621 deploy it would
 * ALSO cut off accounts that legitimately should keep the free entry tier:
 * legacy users created before billing existed, and the few left without an
 * active sub by the (now-fixed) TER-625 non-atomic plan change. createUser has
 * provisioned a Starter sub since billing landed; this migration repairs the
 * accounts that predate that guarantee, so it must ship with (or before) TER-621.
 *
 * Conservative by design: only users WITHOUT an active sub are touched. A user
 * who already has an active sub (any tier) is left exactly as-is — we never
 * downgrade or duplicate a live subscription. Reuses createDefaultSubscription
 * so the Starter shape stays in lockstep with the signup path (single source of
 * truth: customPrice 0, BETA-free, one-month period).
 *
 * Idempotent two ways: the distinct({status:'active'}) filter excludes anyone
 * who already has an active sub, so a re-run provisions nothing; and the partial
 * unique index billing_sub_one_active (ensured before migrations run) makes a
 * duplicate active sub impossible by construction — a concurrent insert that
 * lost the race surfaces as E11000, which we treat as an already-provisioned
 * no-op rather than a failure.
 */
const migration: Migration = {
  description:
    "Backfill an active Starter subscription for users without one " +
    "(safety net for TER-621, which blocks the Teros model when no active sub exists).",

  async up(db: Db): Promise<void> {
    const users = db.collection<{ userId: string }>("users")
    const subsCol = getBillingSubscriptionsCollection(db)

    // Users that already have an ACTIVE subscription — never touched.
    const userIdsWithActiveSub = new Set(
      (await subsCol.distinct("userId", { status: "active" })) as string[],
    )

    const allUsers = await users.find({}, { projection: { userId: 1, _id: 0 } }).toArray()
    const targets = allUsers.filter((u) => u.userId && !userIdsWithActiveSub.has(u.userId))

    console.log(
      `[Migration] ${allUsers.length} user(s) total, ${targets.length} without an active subscription — provisioning Starter`,
    )

    let provisioned = 0
    let skipped = 0
    let failed = 0
    for (const { userId } of targets) {
      try {
        await createDefaultSubscription(db, userId)
        provisioned++
      } catch (error) {
        // billing_sub_one_active (partial unique) rejected a second active sub:
        // the user was provisioned concurrently. An idempotent no-op, not a failure.
        if ((error as { code?: number }).code === 11000) {
          skipped++
          continue
        }
        failed++
        console.error(
          `[Migration] Failed to provision Starter subscription for user ${userId}:`,
          error,
        )
      }
    }

    console.log(
      `[Migration] Provisioned Starter subscription for ${provisioned} user(s) ` +
        `(${skipped} already active, ${failed} failed)`,
    )
  },
}

export default migration
