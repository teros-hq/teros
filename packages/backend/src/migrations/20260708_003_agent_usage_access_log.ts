import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Append-only admin access audit-log (A6.3 / TER-671).
 *
 * `agent_usage_access_log` records every `agent-usage-session-detail` read (who,
 * which session, whether plaintext was included, when). Additive collection with
 * lookup indexes + a 730d TTL (matches the rollup retention — long enough to
 * investigate an incident, bounded so it can't grow forever).
 */
const TTL_730_DAYS = 60 * 60 * 24 * 730;

const migration: Migration = {
  description:
    'Admin access audit-log: agent_usage_access_log (by session + by admin, 730d TTL)',

  async up(db: Db): Promise<void> {
    const col = db.collection('agent_usage_access_log');
    await col.createIndex({ sessionUsageId: 1, at: -1 }, { name: 'session_at' });
    await col.createIndex({ adminUserId: 1, at: -1 }, { name: 'admin_at' });
    await col.createIndex({ at: 1 }, { expireAfterSeconds: TTL_730_DAYS, name: 'ttl_730d' });
    console.log('[Migration] Created agent_usage_access_log with 3 indexes');
  },

  async down(db: Db): Promise<void> {
    try {
      await db.collection('agent_usage_access_log').drop();
      console.log('[Migration] Dropped agent_usage_access_log');
    } catch (err) {
      if ((err as { code?: number }).code !== 26) throw err; // NamespaceNotFound
    }
  },
};

export default migration;
