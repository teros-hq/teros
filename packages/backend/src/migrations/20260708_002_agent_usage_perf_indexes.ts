import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Performance indexes for the monitoring dashboard hot paths (A4.1/A4.2/A4.7,
 * TER-667). All additive — no existing index is touched.
 *
 *   - agent_usage_sessions {startedAt:-1}: the default admin dashboard query
 *     (no filter) + the ~9 live-folds/min were SORT←COLLSCAN because every
 *     existing index carries startedAt in 2nd/3rd position. Measured 73 ms→0 at
 *     ×100.
 *   - tool_executions {startedAt:-1} + {workspaceId:1,startedAt:-1}: the tool
 *     list COLLSCANned even when filtered by workspaceId (×90 measured).
 *   - agents {agentId:1} unique: agents had only `_id_`, so agentId lookups in
 *     the directory + session-detail were COLLSCAN. agentId is the logical PK.
 *   - message_feedback {createdAt:1}: aggregateThumbs `$match createdAt` will
 *     COLLSCAN once the collection fills.
 *
 * `createIndex` is idempotent (a re-run with the same spec is a no-op), so this
 * migration is safe to re-apply and cannot crash boot. The one exception — the
 * unique agents index — is created defensively: if legacy data holds duplicate
 * agentIds it falls back to a non-unique index (keeping the perf win) and logs a
 * warning rather than aborting startup.
 */
const migration: Migration = {
  description:
    'Monitoring perf indexes: sessions/tool_executions startedAt, agents.agentId unique, message_feedback.createdAt (additive)',

  async up(db: Db): Promise<void> {
    await db
      .collection('agent_usage_sessions')
      .createIndex({ startedAt: -1 }, { name: 'startedAt_desc' });
    console.log('[Migration] agent_usage_sessions.startedAt_desc');

    await db
      .collection('tool_executions')
      .createIndex({ startedAt: -1 }, { name: 'startedAt_desc' });
    await db
      .collection('tool_executions')
      .createIndex({ workspaceId: 1, startedAt: -1 }, { name: 'workspace_startedAt' });
    console.log('[Migration] tool_executions.startedAt_desc + workspace_startedAt');

    try {
      await db.collection('agents').createIndex({ agentId: 1 }, { unique: true, name: 'agentId_unique' });
      console.log('[Migration] agents.agentId_unique');
    } catch (err) {
      // Duplicate agentIds in legacy data would make the unique build fail with
      // E11000. Don't crash boot — keep the (non-unique) index for the perf win
      // and surface the data problem loudly.
      if ((err as { code?: number }).code === 11000) {
        await db.collection('agents').createIndex({ agentId: 1 }, { name: 'agentId_idx' });
        console.warn(
          '[Migration] agents.agentId has duplicates — created NON-unique agentId_idx; investigate the dupes',
        );
      } else {
        throw err;
      }
    }

    await db
      .collection('message_feedback')
      .createIndex({ createdAt: 1 }, { name: 'createdAt_asc' });
    console.log('[Migration] message_feedback.createdAt_asc');
  },

  async down(db: Db): Promise<void> {
    const drops: Array<[string, string]> = [
      ['agent_usage_sessions', 'startedAt_desc'],
      ['tool_executions', 'startedAt_desc'],
      ['tool_executions', 'workspace_startedAt'],
      ['agents', 'agentId_unique'],
      ['agents', 'agentId_idx'],
      ['message_feedback', 'createdAt_asc'],
    ];
    for (const [col, name] of drops) {
      try {
        await db.collection(col).dropIndex(name);
        console.log(`[Migration] dropped ${col}.${name}`);
      } catch (err) {
        // Index may not exist; ignore IndexNotFound (code 27)
        if ((err as { code?: number }).code !== 27) throw err;
      }
    }
  },
};

export default migration;
