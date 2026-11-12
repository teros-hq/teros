import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Compound index `session_messages({ "info.sessionID": 1, "info.role": 1, "info.meta.queueState": 1 })`.
 *
 * The backend queries session_messages on every message sent to check for
 * pending/running queued messages in a channel:
 *
 *   find({ "info.role": "user",
 *          "info.sessionID": { $in: [channelId] },
 *          "info.meta.queueState": { $in: ["pending", "running"] } })
 *
 * No existing index covers the nested `info.sessionID` / `info.role` /
 * `info.meta.queueState` fields, so MongoDB falls back to a COLLSCAN across
 * the full collection (~437K docs, ~1.1 GB), taking 700-940ms per query and
 * driving MongoDB CPU to ~62%.
 *
 * This compound index turns the scan into an index seek, reducing the query
 * to <5ms.
 *
 * Additive and non-destructive — the fields already exist on every document.
 */
const migration: Migration = {
  description:
    'Compound index session_messages(info.sessionID, info.role, info.meta.queueState) — eliminates COLLSCAN on queue-state queries',

  async up(db: Db): Promise<void> {
    const col = db.collection('session_messages');
    await col.createIndex(
      { 'info.sessionID': 1, 'info.role': 1, 'info.meta.queueState': 1 },
      { name: 'info.sessionID_role_queueState', background: true },
    );
    console.log('[Migration] Created index session_messages.info.sessionID_role_queueState');
  },

  async down(db: Db): Promise<void> {
    try {
      await db.collection('session_messages').dropIndex('info.sessionID_role_queueState');
      console.log('[Migration] Dropped session_messages.info.sessionID_role_queueState index');
    } catch (err) {
      // IndexNotFound (27) — already gone; ignore.
      if ((err as { code?: number }).code !== 27) {
        throw err;
      }
    }
  },
};

export default migration;
