import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Per-hour rollup completion markers (A1.2 / TER-665).
 *
 * Adds `agent_usage_rollup_runs`: one doc per fully-rolled closed hour. The
 * hourly rollup job gates on the presence of a marker instead of "does any
 * rollup doc exist for this hour", so demo-seed rollups and partial writes no
 * longer brick an hour. Additive and non-destructive.
 *
 * The unique index on `hourBucket` makes a duplicate marker impossible even if
 * two instances race the leader lock. TTL is generous (180d) — only the last
 * `catchUpHours` (default 72h) of markers are ever read, so anything older is dead
 * weight, but 180d keeps re-runnable history around and matches the sessions TTL.
 */
const TTL_180_DAYS = 60 * 60 * 24 * 180;

const migration: Migration = {
  description:
    'Agent usage rollup completion markers: agent_usage_rollup_runs (unique hourBucket + 180d TTL)',

  async up(db: Db): Promise<void> {
    const col = db.collection('agent_usage_rollup_runs');
    await col.createIndex({ hourBucket: 1 }, { unique: true, name: 'hourBucket_unique' });
    await col.createIndex(
      { completedAt: 1 },
      { expireAfterSeconds: TTL_180_DAYS, name: 'ttl_180d' },
    );
    console.log('[Migration] Created agent_usage_rollup_runs with 2 indexes');
  },

  async down(db: Db): Promise<void> {
    try {
      await db.collection('agent_usage_rollup_runs').drop();
      console.log('[Migration] Dropped agent_usage_rollup_runs');
    } catch (err) {
      // Collection may not exist; ignore NamespaceNotFound (code 26)
      if ((err as { code?: number }).code !== 26) {
        throw err;
      }
    }
  },
};

export default migration;
