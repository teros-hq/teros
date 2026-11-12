import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Backfill `visibility: "private"` on all legacy channels.
 *
 * Channels created before the multi-user-workspaces feature do not have a
 * `visibility` field. The original NFR-3 treated these as "public" for
 * backward compatibility. On 2026-09-15 Pablo reversed that decision:
 * every conversation is private by default, including pre-existing ones.
 *
 * This migration sets `visibility: "private"` on every channel document that
 * lacks the field. Idempotent by construction — the filter `{ visibility:
 * { $exists: false } }` matches nothing once all documents have the field.
 *
 * Replaces the standalone script from MUW-14 (`scripts/migrate-legacy-visibility.ts`),
 * which was deleted when this formal migration was introduced.
 */

const migration: Migration = {
  description:
    'Backfill visibility:"private" on legacy channels missing the field (idempotent)',

  async up(db: Db): Promise<void> {
    const channels = db.collection('channels');

    const beforeCount = await channels.countDocuments({ visibility: { $exists: false } });
    console.log(
      `[Migration] legacy_channels_private: ${beforeCount} channels without visibility field found.`,
    );

    if (beforeCount === 0) {
      console.log('[Migration] legacy_channels_private: nothing to do — all channels already have visibility set.');
      return;
    }

    const result = await channels.updateMany(
      { visibility: { $exists: false } },
      { $set: { visibility: 'private' } },
    );

    console.log(
      `[Migration] legacy_channels_private: ${result.modifiedCount} channels set to private (matched ${result.matchedCount}).`,
    );

    // Verify: 0 channels without visibility after migration
    const afterCount = await channels.countDocuments({ visibility: { $exists: false } });
    if (afterCount !== 0) {
      throw new Error(
        `legacy_channels_private: migration incomplete — ${afterCount} channels still lack visibility field.`,
      );
    }

    console.log('[Migration] legacy_channels_private: ✓ complete.');
  },
};

export default migration;
