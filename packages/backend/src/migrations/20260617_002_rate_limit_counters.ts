import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Rate limit counters (FASE 5b).
 *
 * Brand-new collection `rate_limit_counters` holding one document per
 * (scope, key, window). A TTL index on `expiresAt` (expireAfterSeconds: 0)
 * removes each window the moment its exact expiry time passes, so the
 * collection self-prunes without a sweep job.
 */

const TTL_INDEX = 'rate_limit_counters_ttl';

const migration: Migration = {
  description: 'Rate limit counters: TTL index for automatic window pruning',

  async up(db: Db): Promise<void> {
    const col = db.collection('rate_limit_counters');
    // TTL on the exact expiry time: Mongo removes a window doc once expiresAt passes.
    await col.createIndex({ expiresAt: 1 }, { name: TTL_INDEX, expireAfterSeconds: 0 });
    console.log(`[Migration] Created ${TTL_INDEX} TTL on rate_limit_counters`);
  },

  async down(db: Db): Promise<void> {
    try {
      await db.collection('rate_limit_counters').dropIndex(TTL_INDEX);
      console.log(`[Migration] Dropped ${TTL_INDEX} from rate_limit_counters`);
    } catch (err) {
      if ((err as { code?: number }).code !== 27) throw err;
      console.log(`[Migration] ${TTL_INDEX} did not exist, skipping`);
    }
  },
};

export default migration;
