import type { Db } from 'mongodb';
import type { Migration } from './types.js';

const migration: Migration = {
  description:
    'Add TTL index on subscriptions_channel.lastActivityAt (24h inactivity expiry) and backfill missing lastActivityAt values',

  async up(db: Db): Promise<void> {
    const col = db.collection('subscriptions_channel');

    // Create TTL index: documents expire 24 hours after lastActivityAt
    await col.createIndex(
      { lastActivityAt: 1 },
      { expireAfterSeconds: 86400, name: 'sliding_ttl' },
    );
    console.log('[Migration] Created TTL index sliding_ttl on subscriptions_channel');

    // Backfill: set lastActivityAt = now for any documents that are missing it
    const result = await col.updateMany(
      { lastActivityAt: { $exists: false } },
      { $set: { lastActivityAt: new Date() } },
    );
    if (result.modifiedCount > 0) {
      console.log(
        `[Migration] Backfilled lastActivityAt on ${result.modifiedCount} subscriptions_channel document(s)`,
      );
    }
  },

  async down(db: Db): Promise<void> {
    const col = db.collection('subscriptions_channel');
    await col.dropIndex('sliding_ttl');
    console.log('[Migration] Dropped TTL index sliding_ttl from subscriptions_channel');
    // Note: backfilled lastActivityAt values are not reverted — adding a date is not destructive
  },
};

export default migration;
