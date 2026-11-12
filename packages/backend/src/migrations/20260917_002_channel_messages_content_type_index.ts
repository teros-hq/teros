import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Compound index `channel_messages({ channelId: 1, "content.type": 1, timestamp: -1 })`.
 *
 * Multiple handlers query channel_messages filtering by channelId + content.type
 * with a sort on timestamp (desc):
 *
 *   - pre-publish-scan: find({ channelId, "content.type": "tool_execution" })
 *   - permission-manager: find({ channelId, "content.type": "tool_execution",
 *       "content.status": "pending_permission" })
 *   - voice-handler: find({ channelId, "content.type": "text" },
 *       { sort: { timestamp: -1 }, limit })
 *
 * The existing index { channelId: 1, timestamp: -1 } covers channelId + sort but
 * cannot filter on content.type efficiently — MongoDB must fetch every document in
 * the channel to check content.type. This compound index lets MongoDB seek directly
 * to the matching content.type within the channel, then walk timestamp in order.
 *
 * Additive and non-destructive.
 */
const migration: Migration = {
  description:
    'Compound index channel_messages(channelId, content.type, timestamp) — optimises pre-publish-scan, permission-manager and voice-handler queries',

  async up(db: Db): Promise<void> {
    const col = db.collection('channel_messages');
    await col.createIndex(
      { channelId: 1, 'content.type': 1, timestamp: -1 },
      { name: 'channelId_contentType_timestamp', background: true },
    );
    console.log('[Migration] Created index channel_messages.channelId_contentType_timestamp');
  },

  async down(db: Db): Promise<void> {
    try {
      await db.collection('channel_messages').dropIndex('channelId_contentType_timestamp');
      console.log('[Migration] Dropped channel_messages.channelId_contentType_timestamp index');
    } catch (err) {
      if ((err as { code?: number }).code !== 27) {
        throw err;
      }
    }
  },
};

export default migration;
