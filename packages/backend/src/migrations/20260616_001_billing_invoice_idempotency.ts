import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Make billing_invoices idempotent per billing period.
 *
 * The billing-reset-cron creates one invoice per subscription per period.
 * Without a unique constraint, a crash between invoice insert and the
 * subscription reset (or a duplicated tick) produces duplicate invoices.
 *
 * This migration:
 *   1. De-duplicates any existing invoices sharing
 *      (subscriptionId, periodStart, periodEnd), keeping the oldest.
 *   2. Creates a unique compound index so future duplicates are impossible
 *      and the cron can switch insertOne -> updateOne(upsert) safely.
 */

const INDEX_NAME = 'billing_inv_period_unique';

const migration: Migration = {
  description:
    'De-duplicate billing_invoices and add unique index {subscriptionId, periodStart, periodEnd}',

  async up(db: Db): Promise<void> {
    // billing_invoices._id is a string UUID (not ObjectId), so type the
    // collection accordingly for the $in / sort below.
    const col = db.collection<{ _id: string; createdAt: Date }>('billing_invoices');

    // 1. Find duplicate groups and drop all but the oldest invoice in each.
    const dupes = await col
      .aggregate<{ _id: { s: string; ps: Date; pe: Date }; ids: string[] }>([
        {
          $group: {
            _id: { s: '$subscriptionId', ps: '$periodStart', pe: '$periodEnd' },
            ids: { $push: '$_id' },
            firstCreatedAt: { $min: '$createdAt' },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    let removed = 0;
    for (const group of dupes) {
      // Keep the oldest by createdAt; if tie, keep the first id deterministically.
      const docs = await col
        .find({ _id: { $in: group.ids } })
        .sort({ createdAt: 1, _id: 1 })
        .toArray();
      const toDelete = docs.slice(1).map((d) => d._id);
      if (toDelete.length > 0) {
        const res = await col.deleteMany({ _id: { $in: toDelete } });
        removed += res.deletedCount ?? 0;
      }
    }
    if (removed > 0) {
      console.log(`[Migration] Removed ${removed} duplicate billing_invoices before unique index`);
    }

    // 2. Create the unique compound index — UNLESS it already exists. ensureBillingIndexes
    //    runs at boot BEFORE migrations and now seeds this index with the PARTIAL
    //    kind:'subscription' spec (TER-596 I1). A plain createIndex here would have the
    //    same name + key but a different option (no partial filter) → IndexOptionsConflict
    //    (code 85), crashing boot on a fresh DB. The index's purpose (period-uniqueness for
    //    the reset-cron upsert) is already satisfied by the existing one, and migration
    //    20260623_001 reconciles the spec to partial regardless — so skip if present.
    const existing = await col.listIndexes().toArray();
    if (existing.some((idx) => idx.name === INDEX_NAME)) {
      console.log(`[Migration] ${INDEX_NAME} already exists (seeded at boot); skipping create`);
      return;
    }
    await col.createIndex(
      { subscriptionId: 1, periodStart: 1, periodEnd: 1 },
      { unique: true, name: INDEX_NAME },
    );
    console.log(`[Migration] Created ${INDEX_NAME} unique index on billing_invoices`);
  },

  async down(db: Db): Promise<void> {
    const col = db.collection('billing_invoices');
    try {
      await col.dropIndex(INDEX_NAME);
      console.log(`[Migration] Dropped ${INDEX_NAME} index`);
    } catch (err) {
      if ((err as { code?: number }).code !== 27) throw err;
      console.log(`[Migration] ${INDEX_NAME} index did not exist, skipping`);
    }
  },
};

export default migration;
