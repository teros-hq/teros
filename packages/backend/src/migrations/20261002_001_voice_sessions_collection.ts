import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Voice Mode v2 — Fase 0 (spec v1.1.0, REQ-2 + REQ-6):
 *
 * 1. Create the `voice_sessions` collection with its indexes. One record per
 *    (channelId, agentId): the persistent voice session state (mode, presence,
 *    startedAt/lastActivityAt). The voice-handler upserts on connect, touches
 *    on activity, and marks presence 'off' on cleanup. The `mode` field stores
 *    the canonical Voice Mode v2 axis ('conversation' | 'passive' —
 *    'attention' existed briefly in F2 and was removed 2026-10-05, two modes
 *    only) — the legacy engine maps active→conversation, silent→passive at
 *    write time (voice-handler toCanonicalMode), so F2 builds on this without
 *    another migration.
 *
 * 2. Archive historical voice channels: every channel with
 *    `metadata.transport === 'voice'` (the old "Voice Conversation" channels
 *    created by the pre-F0 handleConnection) gets `status: 'archived'`.
 *    Decision from the spec: ARCHIVE, do NOT migrate — their transcripts stay
 *    readable in history, they just stop appearing in the active conversation
 *    list. With F0 no new transport:'voice' channels are ever created
 *    (the voice session lives in the conversation channel itself), so this
 *    is a one-time cleanup of the legacy footprint.
 *
 * Idempotent: createIndex is a no-op when the index exists; the archive
 *    update matches nothing once there are no live transport:'voice' channels.
 */
const migration: Migration = {
  description:
    'Voice Mode v2 F0: create voice_sessions collection (+indexes) and archive legacy transport:voice channels',

  async up(db: Db): Promise<void> {
    // --- 1. voice_sessions collection + indexes ------------------------------
    const sessions = db.collection('voice_sessions');

    // Unique session per (channelId, agentId) — the upsert key used by the
    // voice-handler (upsertVoiceSession / touchVoiceSession / closeVoiceSession).
    await sessions.createIndex(
      { channelId: 1, agentId: 1 },
      { name: 'channelId_agentId_unique', unique: true, background: true },
    );
    // Look up a user's sessions ordered by recency (future voice session list UI).
    await sessions.createIndex(
      { userId: 1, lastActivityAt: -1 },
      { name: 'userId_lastActivityAt', background: true },
    );
    console.log('[Migration] Created voice_sessions collection + indexes (channelId_agentId_unique, userId_lastActivityAt)');

    // --- 2. Archive legacy voice channels -------------------------------------
    const channels = db.collection('channels');
    const result = await channels.updateMany(
      { 'metadata.transport': 'voice', status: { $ne: 'archived' } },
      {
        $set: {
          status: 'archived',
          archivedAt: new Date(),
          archiveReason: 'voice-mode-v2-f0-legacy-voice-channel',
        },
      },
    );
    console.log(
      `[Migration] Archived ${result.modifiedCount} legacy transport:'voice' channel(s) (Voice Mode v2 F0 — no migration, per spec decision)`,
    );
  },

  async down(db: Db): Promise<void> {
    // Drop the voice_sessions indexes (collection itself is left — MongoDB
    // collections are cheap; dropping it would lose session state).
    try {
      await db.collection('voice_sessions').dropIndex('channelId_agentId_unique');
      await db.collection('voice_sessions').dropIndex('userId_lastActivityAt');
      console.log('[Migration] Dropped voice_sessions indexes');
    } catch (err) {
      // IndexNotFound (27) — already gone; ignore.
      if ((err as { code?: number }).code !== 27) {
        throw err;
      }
    }

    // Unarchive the legacy voice channels this migration archived (only those
    // marked by this migration — archiveReason is the discriminator).
    const channels = db.collection('channels');
    const result = await channels.updateMany(
      { archiveReason: 'voice-mode-v2-f0-legacy-voice-channel' },
      {
        $set: { status: 'active' },
        $unset: { archivedAt: '', archiveReason: '' },
      },
    );
    console.log(`[Migration] Restored ${result.modifiedCount} legacy voice channel(s) from archive`);
  },
};

export default migration;
