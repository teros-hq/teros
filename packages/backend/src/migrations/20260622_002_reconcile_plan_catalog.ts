import type { Db } from 'mongodb';
import type { Migration } from './types.js';
import {
  BILLING_PLANS_SEED,
  RETIRED_PLAN_REMAP,
  getBillingPlansCollection,
  getBillingSubscriptionsCollection,
  getBillingTeamsCollection,
} from '../models/billing.js';

/**
 * Reconcile billing_plans to the public catalogue (TER-596 G0).
 *
 * The seeded catalogue drifted from the pricing page (teros.ai): the DB had
 * Essential(0h)/Pro(80h·€89)/Max(200h·€179)/Infinity(1000h), the page has
 * Starter(10h·€9, free in beta) / Growth(40h·€89) / Pro(80h·€179) /
 * Ultra(200h·€349) / Enterprise(unlimited). This migration brings the DB in
 * line:
 *   1. Upserts the canonical catalogue with $set — seedBillingPlans only uses
 *      $setOnInsert, so it would NOT correct a reused id's price (plan_pro's
 *      €89→€179) on an existing DB.
 *   2. Remaps every reference still pointing at a retired plan to its successor
 *      (plan_basic→plan_starter, plan_max→plan_ultra, plan_infinity→plan_enterprise)
 *      THEN removes the retired plan docs. Remap first so nothing is ever left
 *      dangling between the two steps. Three references can hold a planId: a
 *      subscription's active `planId`, its deferred-downgrade target
 *      `scheduledPlanChange.planId` (F8), and a `billing_teams.planId`.
 *
 * Not in production yet (billing lives in unmerged draft PRs), so there is no
 * real-user impact — this also self-heals the isolated smoke DB.
 */
const migration: Migration = {
  description:
    'Reconcile billing_plans to the public catalogue (Starter/Growth/Pro/Ultra/Enterprise) + remap retired plans (TER-596 G0)',

  async up(db: Db): Promise<void> {
    const now = new Date();
    const plans = getBillingPlansCollection(db);

    // 1. Upsert the canonical catalogue. $set corrects mutable fields on reused
    //    ids; $setOnInsert seeds createdAt for fresh inserts. _id comes from the
    //    filter on insert and must never appear in $set.
    for (const plan of BILLING_PLANS_SEED) {
      const { _id, ...fields } = plan;
      await plans.updateOne(
        { _id },
        { $set: { ...fields, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
    }

    // 2. Remap every reference off retired plans BEFORE deleting those plan docs.
    //    Both `subscriptions.planId` and `billing_teams.planId` are top-level.
    const subs = getBillingSubscriptionsCollection(db);
    const teams = getBillingTeamsCollection(db);
    for (const [oldId, newId] of Object.entries(RETIRED_PLAN_REMAP)) {
      const r = await subs.updateMany(
        { planId: oldId },
        { $set: { planId: newId, updatedAt: now } },
      );
      if (r.modifiedCount > 0) {
        console.log(`[Migration] Remapped ${r.modifiedCount} subscription(s) ${oldId} → ${newId}`);
      }
      const t = await teams.updateMany(
        { planId: oldId },
        { $set: { planId: newId, updatedAt: now } },
      );
      if (t.modifiedCount > 0) {
        console.log(`[Migration] Remapped ${t.modifiedCount} team(s) ${oldId} → ${newId}`);
      }
    }

    // scheduledPlanChange.planId is a NESTED field (F8 deferred downgrade). Remap
    // each affected sub by _id with a full-object replace — no dotted-path update
    // operator, which keeps both real Mongo and the in-memory test fake honest.
    const remap = RETIRED_PLAN_REMAP as Record<string, string>;
    const scheduled = await subs.find({ scheduledPlanChange: { $exists: true } }).toArray();
    for (const sub of scheduled) {
      const change = sub.scheduledPlanChange;
      const newId = change?.planId ? remap[change.planId] : undefined;
      if (!change || !newId) continue;
      await subs.updateOne(
        { _id: sub._id },
        { $set: { scheduledPlanChange: { ...change, planId: newId }, updatedAt: now } },
      );
      console.log(`[Migration] Remapped scheduled downgrade ${change.planId} → ${newId} on ${sub._id}`);
    }

    const del = await plans.deleteMany({ _id: { $in: Object.keys(RETIRED_PLAN_REMAP) } });
    console.log(
      `[Migration] Reconciled catalogue: ${BILLING_PLANS_SEED.length} plans upserted, ${del.deletedCount} retired plan(s) removed`,
    );
  },

  async down(_db: Db): Promise<void> {
    // Forward-only: the previous catalogue (Essential/Pro@€89/Max/Infinity) is
    // not restored. up() is idempotent, so re-running is safe.
    console.warn('[Migration] reconcile_plan_catalog is forward-only; down() is a no-op');
  },
};

export default migration;
