/**
 * MUW-16 — test for the formal migration `20260915_001_legacy_channels_private`.
 *
 * Verifies:
 * - Channels without `visibility` get `visibility: "private"`.
 * - Channels that already have `visibility` are left untouched.
 * - The migration is idempotent (running twice produces the same result).
 */

import { describe, expect, it } from 'bun:test';
import legacyChannelsPrivateMigration from '../../src/migrations/20260915_001_legacy_channels_private';

// ── Minimal mock DB ──────────────────────────────────────────────────────────
// Supports countDocuments, updateMany — the only two calls the migration uses.

interface MockDoc {
  _id: string;
  visibility?: string;
  [key: string]: unknown;
}

function mockDb(docs: MockDoc[]) {
  const channels = [...docs];

  const col = {
    countDocuments: async (query: Record<string, unknown>): Promise<number> => {
      // Reproduce { visibility: { $exists: false } }
      const existsFalse = query?.visibility?.$exists === false;
      if (existsFalse) {
        return channels.filter((d) => d.visibility === undefined).length;
      }
      return channels.length;
    },

    updateMany: async (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
    ): Promise<{ matchedCount: number; modifiedCount: number }> => {
      const existsFalse = filter?.visibility?.$exists === false;
      let matched = 0;
      let modified = 0;
      if (existsFalse) {
        for (const d of channels) {
          if (d.visibility === undefined) {
            matched++;
            if (update.$set?.visibility !== undefined) {
              d.visibility = update.$set.visibility as string;
              modified++;
            }
          }
        }
      }
      return { matchedCount: matched, modifiedCount: modified };
    },
  };

  return { db: { collection: () => col } as any, channels };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('migration 20260915_001_legacy_channels_private', () => {
  it('sets visibility:"private" on channels missing the field', async () => {
    const { db, channels } = mockDb([
      { _id: '1' }, // no visibility → should become private
      { _id: '2', visibility: 'public' }, // already set → untouched
      { _id: '3', visibility: 'private' }, // already set → untouched
      { _id: '4' }, // no visibility → should become private
    ]);

    await legacyChannelsPrivateMigration.up(db);

    expect(channels[0].visibility).toBe('private');
    expect(channels[1].visibility).toBe('public');
    expect(channels[2].visibility).toBe('private');
    expect(channels[3].visibility).toBe('private');
  });

  it('is idempotent — running twice produces the same result', async () => {
    const { db, channels } = mockDb([
      { _id: 'a' },
      { _id: 'b', visibility: 'public' },
      { _id: 'c' },
    ]);

    // First run
    await legacyChannelsPrivateMigration.up(db);

    expect(channels[0].visibility).toBe('private');
    expect(channels[1].visibility).toBe('public');
    expect(channels[2].visibility).toBe('private');

    const snapshot = channels.map((d) => ({ _id: d._id, visibility: d.visibility }));

    // Second run — should be a complete no-op
    await legacyChannelsPrivateMigration.up(db);

    const afterSecond = channels.map((d) => ({ _id: d._id, visibility: d.visibility }));
    expect(afterSecond).toEqual(snapshot);
  });

  it('is a no-op when all channels already have visibility set', async () => {
    const { db, channels } = mockDb([
      { _id: 'x', visibility: 'private' },
      { _id: 'y', visibility: 'public' },
    ]);

    await legacyChannelsPrivateMigration.up(db);

    // Nothing changed
    expect(channels[0].visibility).toBe('private');
    expect(channels[1].visibility).toBe('public');
  });

  it('is a no-op on an empty channels collection', async () => {
    const { db } = mockDb([]);

    // Should not throw
    await legacyChannelsPrivateMigration.up(db);
  });
});
