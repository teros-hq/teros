import type { Db } from 'mongodb';
import type { Migration } from './types.js';

/**
 * Agent usage instrumentation collections.
 *
 * Creates 6 new collections + 1 sparse index on `llm_usage`. All additive,
 * non-destructive. Existing usage tracking (conversation_usage, llm_usage,
 * usage_windows) is untouched and continues to function.
 *
 *
 */

const TTL_180_DAYS = 60 * 60 * 24 * 180;
const TTL_730_DAYS = 60 * 60 * 24 * 730;

const migration: Migration = {
  description:
    'Agent usage instrumentation: 6 collections (events, event_applications, sessions, tool_executions, rollups hourly + user_hourly) + sparse FK index on llm_usage.sessionUsageId',

  async up(db: Db): Promise<void> {
    // ------------------------------------------------------------------------
    // 1. agent_usage_events (append-only, source of truth)
    // ------------------------------------------------------------------------
    {
      const col = db.collection('agent_usage_events');
      await col.createIndex({ eventId: 1 }, { unique: true, name: 'eventId_unique' });
      await col.createIndex(
        { sessionUsageId: 1, appliedAt: 1 },
        { name: 'sessionUsageId_appliedAt' },
      );
      await col.createIndex(
        { appliedAt: 1 },
        { expireAfterSeconds: TTL_180_DAYS, name: 'ttl_180d' },
      );
      console.log('[Migration] Created agent_usage_events with 3 indexes');
    }

    // ------------------------------------------------------------------------
    // 2. agent_usage_event_applications (idempotency of the applier)
    // ------------------------------------------------------------------------
    {
      const col = db.collection('agent_usage_event_applications');
      await col.createIndex({ eventId: 1 }, { unique: true, name: 'eventId_unique' });
      await col.createIndex(
        { projectedAt: 1 },
        { expireAfterSeconds: TTL_180_DAYS, name: 'ttl_180d' },
      );
      console.log('[Migration] Created agent_usage_event_applications with 2 indexes');
    }

    // ------------------------------------------------------------------------
    // 3. agent_usage_sessions (projection, one per turn)
    // ------------------------------------------------------------------------
    {
      const col = db.collection('agent_usage_sessions');
      await col.createIndex({ sessionUsageId: 1 }, { unique: true, name: 'sessionUsageId_unique' });
      await col.createIndex(
        { userId: 1, agentId: 1, startedAt: -1 },
        { name: 'user_agent_started' },
      );
      await col.createIndex(
        { userId: 1, agentId: 1, provider: 1, startedAt: -1 },
        { name: 'user_agent_provider_started' },
      );
      await col.createIndex({ workspaceId: 1, startedAt: -1 }, { name: 'workspace_started' });
      await col.createIndex({ status: 1, startedAt: 1 }, { name: 'status_started_reconcile' });
      await col.createIndex({ channelId: 1, startedAt: -1 }, { name: 'channel_started' });
      await col.createIndex(
        { parentSessionUsageId: 1 },
        { sparse: true, name: 'parent_sparse' },
      );
      await col.createIndex(
        { triggerKind: 1, startedAt: -1 },
        { sparse: true, name: 'triggerKind_started' },
      );
      await col.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: TTL_180_DAYS, name: 'ttl_180d' },
      );
      console.log('[Migration] Created agent_usage_sessions with 9 indexes');
    }

    // ------------------------------------------------------------------------
    // 4. tool_executions (append-only, one per tool call)
    // ------------------------------------------------------------------------
    {
      const col = db.collection('tool_executions');
      await col.createIndex(
        { toolExecutionId: 1 },
        { unique: true, name: 'toolExecutionId_unique' },
      );
      await col.createIndex(
        { sessionUsageId: 1, stepIndex: 1, toolCallIndex: 1 },
        { name: 'session_step_toolcall' },
      );
      await col.createIndex(
        { userId: 1, toolName: 1, startedAt: -1 },
        { name: 'user_tool_started' },
      );
      await col.createIndex(
        { mcaId: 1, startedAt: -1 },
        { sparse: true, name: 'mca_started_sparse' },
      );
      await col.createIndex({ status: 1, startedAt: 1 }, { name: 'status_started_reconcile' });
      await col.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: TTL_180_DAYS, name: 'ttl_180d' },
      );
      console.log('[Migration] Created tool_executions with 6 indexes');
    }

    // ------------------------------------------------------------------------
    // 5. agent_usage_rollups_hourly (projection per agent/hour)
    // ------------------------------------------------------------------------
    {
      const col = db.collection('agent_usage_rollups_hourly');
      await col.createIndex({ rollupId: 1 }, { unique: true, name: 'rollupId_unique' });
      await col.createIndex(
        {
          hourBucket: 1,
          'groupKey.userId': 1,
          'groupKey.agentId': 1,
          'groupKey.provider': 1,
          'groupKey.workspaceId': 1,
        },
        { unique: true, name: 'rollup_groupkey_unique' },
      );
      await col.createIndex(
        { 'groupKey.userId': 1, hourBucket: 1 },
        { name: 'user_hourBucket' },
      );
      await col.createIndex(
        { 'groupKey.workspaceId': 1, hourBucket: 1 },
        { name: 'workspace_hourBucket' },
      );
      await col.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: TTL_730_DAYS, name: 'ttl_730d' },
      );
      console.log('[Migration] Created agent_usage_rollups_hourly with 5 indexes');
    }

    // ------------------------------------------------------------------------
    // 6. agent_usage_rollups_user_hourly (projection per user/hour)
    // ------------------------------------------------------------------------
    {
      const col = db.collection('agent_usage_rollups_user_hourly');
      await col.createIndex({ rollupId: 1 }, { unique: true, name: 'rollupId_unique' });
      await col.createIndex(
        { hourBucket: 1, 'groupKey.userId': 1, 'groupKey.workspaceId': 1 },
        { unique: true, name: 'rollup_user_groupkey_unique' },
      );
      await col.createIndex(
        { 'groupKey.userId': 1, hourBucket: 1 },
        { name: 'user_hourBucket' },
      );
      await col.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: TTL_730_DAYS, name: 'ttl_730d' },
      );
      console.log('[Migration] Created agent_usage_rollups_user_hourly with 4 indexes');
    }

    // ------------------------------------------------------------------------
    // Extension: sparse FK on llm_usage.sessionUsageId
    // ------------------------------------------------------------------------
    {
      const col = db.collection('llm_usage');
      await col.createIndex(
        { sessionUsageId: 1 },
        { sparse: true, name: 'sessionUsageId_sparse' },
      );
      console.log('[Migration] Created sparse index llm_usage.sessionUsageId_sparse');
    }
  },

  async down(db: Db): Promise<void> {
    const collections = [
      'agent_usage_events',
      'agent_usage_event_applications',
      'agent_usage_sessions',
      'tool_executions',
      'agent_usage_rollups_hourly',
      'agent_usage_rollups_user_hourly',
    ];

    for (const name of collections) {
      try {
        await db.collection(name).drop();
        console.log(`[Migration] Dropped ${name}`);
      } catch (err) {
        // Collection may not exist; ignore NamespaceNotFound (code 26)
        if ((err as { code?: number }).code !== 26) {
          throw err;
        }
      }
    }

    // Remove the sparse FK index from llm_usage (the column stays — additive)
    try {
      await db.collection('llm_usage').dropIndex('sessionUsageId_sparse');
      console.log('[Migration] Dropped llm_usage.sessionUsageId_sparse index');
    } catch (err) {
      // Index may not exist; ignore IndexNotFound (code 27)
      if ((err as { code?: number }).code !== 27) {
        throw err;
      }
    }
  },
};

export default migration;
