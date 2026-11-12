import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Voice Mode v2 — Fase 4 (spec v1.1.0, REQ-11 + UC-12):
 *
 * Create the `voice_telemetry_sessions` collection with its indexes — the
 * persisted half of the voice health telemetry (F4). One document per voice
 * session (native loop): duration, turns, overheard, barge-ins (client/VAD),
 * audio drops (stt/tts errors), reconnects, per-mode utterance mix, and the
 * session's end-to-end latency summary.
 *
 * Written by the loop: a live snapshot every 60 s while the session is open
 * (a backend crash must not lose an in-flight session's record — AC-6
 * always-on sessions run for hours) and a sealed snapshot at cleanup. The
 * per-utterance gate decisions (falsos positivos/negativos por capa) stay in
 * the in-memory ring buffer + hour rollups — the session record carries the
 * join key (channelId + startedAt) that makes the per-session derivation
 * possible downstream.
 *
 * Idempotent: createIndex is a no-op when the index exists.
 */
const migration: Migration = {
  description:
    'Voice Mode v2 F4: create voice_telemetry_sessions collection (+indexes) for session health records',

  async up(db: Db): Promise<void> {
    const sessions = db.collection('voice_telemetry_sessions');

    // Upsert key — the periodic flush and the close flush write the SAME
    // record (recordId = channelId:startedAt).
    await sessions.createIndex(
      { recordId: 1 },
      { name: 'recordId_unique', unique: true, background: true },
    );
    // A channel's session history, newest first (the per-session UC-12 health
    // derivation: false-positive/negative rate per session of a channel).
    await sessions.createIndex(
      { channelId: 1, startedAt: -1 },
      { name: 'channelId_startedAt', background: true },
    );
    // A user's sessions by recency (the fleet dashboard's default query).
    await sessions.createIndex(
      { userId: 1, startedAt: -1 },
      { name: 'userId_startedAt', background: true },
    );
    console.log('[Migration] Created voice_telemetry_sessions collection + indexes (recordId_unique, channelId_startedAt, userId_startedAt)');
  },

  async down(db: Db): Promise<void> {
    // Drop the indexes only — the collection itself is left (MongoDB
    // collections are cheap; dropping it would lose health records).
    try {
      await db.collection('voice_telemetry_sessions').dropIndex('recordId_unique');
      await db.collection('voice_telemetry_sessions').dropIndex('channelId_startedAt');
      await db.collection('voice_telemetry_sessions').dropIndex('userId_startedAt');
      console.log('[Migration] Dropped voice_telemetry_sessions indexes');
    } catch (err) {
      // IndexNotFound (27) — already gone; ignore.
      if ((err as { code?: number }).code !== 27) {
        throw err;
      }
    }
  },
};

export default migration;
