import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Leader election collection — distributed lock backing for the agent usage
 * background jobs when Teros runs in multi-instance mode (PM2 cluster, N pods).
 *
 * Schema:
 *   name        — logical lock identifier (unique PK)
 *   ownerId     — instance id of the current holder
 *   acquiredAt  — first acquisition timestamp
 *   expiresAt   — lease expiration (TTL-indexed so dead owners get GC'd)
 *
 * The TTL index uses Mongo's background reaper; the application logic does
 * NOT rely on the reaper for correctness — leases are honored via the
 * `expiresAt` comparison in `LeaderElectionService.tryAcquire`. The TTL is
 * just a safety net to keep the collection bounded.
 *
 *
 */

const migration: Migration = {
  description:
    'Multi-instance leader election: leader_locks collection with unique {name} + TTL index on {expiresAt}',

  async up(db: Db): Promise<void> {
    const col = db.collection('leader_locks');
    await col.createIndex({ name: 1 }, { unique: true, name: 'name_unique' });
    // TTL = 0 means: expire docs whose `expiresAt` field is in the past.
    // Mongo runs the reaper every ~60s so leases may linger briefly past
    // their expiry; the application logic must not rely on the reaper for
    // correctness, only for collection size.
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expiresAt_ttl' });
    console.log('[Migration] Created leader_locks with name_unique + expiresAt_ttl');
  },

  async down(db: Db): Promise<void> {
    try {
      await db.collection('leader_locks').drop();
      console.log('[Migration] Dropped leader_locks');
    } catch (err) {
      if ((err as { code?: number }).code !== 26) throw err;
    }
  },
};

export default migration;
