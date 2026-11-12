import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Compound index `channel_messages({ userId: 1, role: 1, timestamp: 1 })`.
 *
 * The admin list-users handler runs an aggregation on channel_messages that
 * matches on userId + role + timestamp (gte) to compute per-user daily message
 * counts:
 *
 *   aggregate([
 *     { $match: { userId: { $in: ids }, role: "user", timestamp: { $gte: since } } },
 *     { $group: { _id: { userId, day: substr(timestamp, 0, 10) }, count: { $sum: 1 } } },
 *   ])
 *
 * The onboarding-status handler also counts documents with { userId, role: "user" }.
 *
 * No existing index covers userId — these queries scan all documents in the
 * collection. This compound index turns the $match into an index range scan.
 *
 * Additive and non-destructive.
 */
const migration: Migration = {
  description:
    'Compound index channel_messages(userId, role, timestamp) — optimises admin list-users aggregation and onboarding-status count',

  async up(db: Db): Promise<void> {
    const col = db.collection('channel_messages');
    await col.createIndex(
      { userId: 1, role: 1, timestamp: 1 },
      { name: 'userId_1_role_1_timestamp_1', background: true },
    );
    console.log('[Migration] Created index channel_messages.userId_1_role_1_timestamp_1');
  },

  async down(db: Db): Promise<void> {
    try {
      await db.collection('channel_messages').dropIndex('userId_1_role_1_timestamp_1');
      console.log('[Migration] Dropped channel_messages.userId_1_role_1_timestamp_1 index');
    } catch (err) {
      if ((err as { code?: number }).code !== 27) {
        throw err;
      }
    }
  },
};

export default migration;
