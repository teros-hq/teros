import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Backfill channel_messages.workspaceId from the message's channel.
 *
 * The future shard key is workspaceId (docs/audit/20261017_plan-data-layer.md
 * §2.1, docs/architecture/sharding-by-workspace.md). ChannelManager.saveMessage
 * now stamps it on every new message; this fills in the existing ones.
 *
 * Batched by channel (one updateMany per channel) and idempotent: only
 * messages without a workspaceId are touched. Channels without a workspaceId
 * (or missing altogether) are logged and skipped, their messages stay as they
 * are. Indexes are not changed here.
 *
 * No down(): a backfilled message can't be told apart from one written with
 * the field, and the field is harmless.
 */
const migration: Migration = {
  description: 'channel_messages: backfill workspaceId from the channel (sharding prep)',

  async up(db: Db): Promise<void> {
    const messages = db.collection('channel_messages');
    const channels = db.collection('channels');

    const pending = messages.aggregate<{ _id: string | null }>(
      [{ $match: { workspaceId: null } }, { $group: { _id: '$channelId' } }],
      { allowDiskUse: true },
    );

    let channelsDone = 0;
    let messagesDone = 0;
    const skipped: string[] = [];
    for await (const { _id: channelId } of pending) {
      if (!channelId) {
        skipped.push('(no channelId)');
        continue;
      }
      const channel = await channels.findOne(
        { channelId },
        { projection: { workspaceId: 1 } },
      );
      const workspaceId = channel?.workspaceId;
      if (typeof workspaceId !== 'string' || !workspaceId) {
        skipped.push(channelId);
        continue;
      }
      const res = await messages.updateMany(
        { channelId, workspaceId: null },
        { $set: { workspaceId } },
      );
      channelsDone++;
      messagesDone += res.modifiedCount;
    }

    console.log(
      `[Migration] channel_messages.workspaceId: ${messagesDone} message(s) in ${channelsDone} channel(s)`,
    );
    if (skipped.length > 0) {
      console.warn(
        `[Migration] channel_messages.workspaceId: skipped ${skipped.length} channel(s) without workspaceId: ` +
          skipped.slice(0, 50).join(', ') +
          (skipped.length > 50 ? ', ...' : ''),
      );
    }
  },
};

export default migration;
