import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Subscription history model (FASE 1f).
 *
 * Adds the lifecycle fields (startDate/endDate) and the structural guard that
 * makes "exactly one active subscription per user" impossible to violate.
 *
 * This migration:
 *   1. Backfills startDate (= createdAt ?? currentPeriodStart) and endDate (null)
 *      on subscriptions that predate the history model.
 *   2. De-duplicates any user with more than one active subscription, keeping
 *      the most recently created and marking the rest status:'ended' — so the
 *      partial unique index can be created safely.
 *   3. Creates the partial unique index {userId} where status:'active'.
 */

const INDEX_NAME = 'billing_sub_one_active';

const migration: Migration = {
  description:
    'Backfill subscription history fields + unique partial index (one active sub per user)',

  async up(db: Db): Promise<void> {
    const col = db.collection<{
      _id: string;
      userId: string;
      status: string;
      createdAt?: Date;
      currentPeriodStart?: Date;
      startDate?: Date;
    }>('billing_subscriptions');

    // 1. Backfill lifecycle fields where missing.
    const missing = await col.find({ startDate: { $exists: false } }).toArray();
    for (const sub of missing) {
      await col.updateOne(
        { _id: sub._id },
        {
          $set: {
            startDate: sub.createdAt ?? sub.currentPeriodStart ?? new Date(),
            endDate: null,
          },
        },
      );
    }
    if (missing.length > 0) {
      console.log(`[Migration] Backfilled startDate/endDate on ${missing.length} subscriptions`);
    }

    // 2. Collapse duplicate active subs per user (keep newest, end the rest).
    const dupes = await col
      .aggregate<{ _id: string; ids: string[] }>([
        { $match: { status: 'active' } },
        { $group: { _id: '$userId', ids: { $push: '$_id' }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    let ended = 0;
    for (const group of dupes) {
      // Keep the most recently created active sub; end the older ones.
      const docs = await col
        .find({ _id: { $in: group.ids } })
        .sort({ createdAt: -1, _id: 1 })
        .toArray();
      const toEnd = docs.slice(1).map((d) => d._id);
      if (toEnd.length > 0) {
        const res = await col.updateMany(
          { _id: { $in: toEnd } },
          { $set: { status: 'ended', endDate: new Date() } },
        );
        ended += res.modifiedCount ?? 0;
      }
    }
    if (ended > 0) {
      console.log(`[Migration] Ended ${ended} duplicate active subscriptions before unique index`);
    }

    // 3. Create the partial unique index.
    await col.createIndex(
      { userId: 1 },
      { unique: true, name: INDEX_NAME, partialFilterExpression: { status: 'active' } },
    );
    console.log(`[Migration] Created ${INDEX_NAME} partial unique index on billing_subscriptions`);
  },

  async down(db: Db): Promise<void> {
    const col = db.collection('billing_subscriptions');
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
