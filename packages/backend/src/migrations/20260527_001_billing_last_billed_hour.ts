import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Add lastBilledHourBucket sparse index to billing_subscriptions.
 *
 * Used by the agent-hours-tracker as an idempotency cursor.
 * Sparse so that subscriptions without the field (legacy docs) are
 * not indexed, keeping the index small.
 */

const migration: Migration = {
  description:
    'Add sparse index billing_subscriptions.lastBilledHourBucket for agent-hours-tracker idempotency',

  async up(db: Db): Promise<void> {
    const col = db.collection('billing_subscriptions');
    await col.createIndex(
      { lastBilledHourBucket: 1 },
      { sparse: true, name: 'lastBilledHourBucket_sparse' },
    );
    console.log('[Migration] Created lastBilledHourBucket_sparse index on billing_subscriptions');
  },

  async down(db: Db): Promise<void> {
    const col = db.collection('billing_subscriptions');
    try {
      await col.dropIndex('lastBilledHourBucket_sparse');
      console.log('[Migration] Dropped lastBilledHourBucket_sparse index');
    } catch (err) {
      if ((err as { code?: number }).code !== 27) throw err;
      console.log('[Migration] lastBilledHourBucket_sparse index did not exist, skipping');
    }
  },
};

export default migration;
