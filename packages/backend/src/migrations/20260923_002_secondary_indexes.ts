import type { Db } from 'mongodb';
import { dropIndexIfExists, ensureIndex } from './helpers.js';
import type { Migration } from './types.js';

/**
 * Secondary indexes for 12 collections that had only _id (COLLSCAN on every query).
 *
 * Verified against actual query patterns in the codebase — no speculative indexes.
 * Collections already covered (skills, agent_skill_access, message_feedback,
 * shared_files) are skipped. Collections that query only by _id
 * (scheduler_counters, system_backfills, scheduler_migrations) need no
 * secondary index.
 *
 * The hottest collections are user_providers and agents: the provider resolver
 * reads them on every message turn. In production (355 / 773 docs) the COLLSCAN
 * is cheap, but it scales linearly — these indexes future-proof the hot path.
 *
 * All unique indexes were checked for duplicate values before creation (none found).
 * Additive and non-destructive — only creates indexes, never drops or modifies data.
 *
 * INF-1 (2026-10-17): this file sat on disk unregistered, so it never ran. Now
 * registered; the billing_plans `planId` index was dropped from it (plans are
 * keyed by `_id`, the field doesn't exist) and every index goes through
 * ensureIndex so legacy data can't abort boot.
 */
const migration: Migration = {
  description:
    'Create secondary indexes on 11 collections that had only _id (user_providers, agents, agent_configs, conversation_usage, user_credentials, volumes, models, agent_cores, mca_data, user_encryption_keys, usage_windows)',

  async up(db: Db): Promise<void> {
    // ── user_providers (hot path — provider resolver reads on every turn) ──
    await ensureIndex(db, 'user_providers', { providerId: 1 }, { name: 'providerId_unique', unique: true });
    await ensureIndex(db, 'user_providers', { userId: 1, status: 1 }, { name: 'userId_status' });
    console.log('[Migration] Created indexes on user_providers');

    // ── agents (list + authz queries) ──
    await ensureIndex(db, 'agents', { ownerId: 1 }, { name: 'ownerId_1' });
    await ensureIndex(db, 'agents', { workspaceId: 1 }, { name: 'workspaceId_1' });
    console.log('[Migration] Created indexes on agents');

    // ── agent_configs (channel-manager queries by channelId) ──
    await ensureIndex(db, 'agent_configs', { channelId: 1 }, { name: 'channelId_1' });
    console.log('[Migration] Created index on agent_configs');

    // ── conversation_usage (usage-service queries by channelId) ──
    // initializeIndexes() exists in usage-service.ts but is never called at boot.
    // This migration creates the indexes that the service was designed to have.
    await ensureIndex(db, 'conversation_usage', { channelId: 1 }, { name: 'channelId_unique', unique: true });
    await ensureIndex(db, 'conversation_usage', { lastUpdated: -1 }, { name: 'lastUpdated_-1' });
    await ensureIndex(db, 'conversation_usage', { userId: 1, lastUpdated: -1 }, { name: 'userId_lastUpdated' });
    await ensureIndex(db, 'conversation_usage', { agentId: 1, lastUpdated: -1 }, { name: 'agentId_lastUpdated' });
    await ensureIndex(db, 'conversation_usage', { workspaceId: 1, lastUpdated: -1 }, { name: 'workspaceId_lastUpdated' });
    await ensureIndex(db, 'conversation_usage', { provider: 1, lastUpdated: -1 }, { name: 'provider_lastUpdated' });
    console.log('[Migration] Created indexes on conversation_usage');

    // ── user_credentials (auth-manager queries by userId+appId) ──
    await ensureIndex(db, 'user_credentials', { userId: 1, appId: 1 }, { name: 'userId_appId_unique', unique: true });
    console.log('[Migration] Created index on user_credentials');

    // ── volumes (volume-service queries by volumeId, ownerId, workspaceId) ──
    await ensureIndex(db, 'volumes', { volumeId: 1 }, { name: 'volumeId_unique', unique: true });
    await ensureIndex(db, 'volumes', { ownerId: 1 }, { name: 'ownerId_1' });
    await ensureIndex(db, 'volumes', { workspaceId: 1 }, { name: 'workspaceId_1' });
    console.log('[Migration] Created indexes on volumes');

    // ── models (model-service queries by modelId, provider+status) ──
    await ensureIndex(db, 'models', { modelId: 1 }, { name: 'modelId_unique', unique: true });
    await ensureIndex(db, 'models', { provider: 1, status: 1 }, { name: 'provider_status' });
    console.log('[Migration] Created indexes on models');

    // ── agent_cores (queried by coreId in mca-resources, provider-service) ──
    await ensureIndex(db, 'agent_cores', { coreId: 1 }, { name: 'coreId_unique', unique: true });
    console.log('[Migration] Created index on agent_cores');

    // ── mca_data (mca-callback-routes queries by appId+scope+key) ──
    await ensureIndex(db, 'mca_data', { appId: 1, scope: 1, key: 1 }, { name: 'appId_scope_key_unique', unique: true });
    console.log('[Migration] Created index on mca_data');

    // ── user_encryption_keys (auth-manager queries by userId) ──
    await ensureIndex(db, 'user_encryption_keys', { userId: 1 }, { name: 'userId_unique', unique: true });
    console.log('[Migration] Created index on user_encryption_keys');

    // ── usage_windows (initializeIndexes exists but never called) ──
    await ensureIndex(db, 'usage_windows', { windowId: 1 }, { name: 'windowId_unique', unique: true });
    await ensureIndex(db, 'usage_windows', { accountId: 1, windowStart: -1 }, { name: 'accountId_windowStart' });
    await ensureIndex(db, 'usage_windows', { windowEnd: 1 }, { name: 'windowEnd_1' });
    console.log('[Migration] Created indexes on usage_windows');

  },

  async down(db: Db): Promise<void> {
    const dropIndexes: [string, string][] = [
      ['user_providers', 'providerId_unique'],
      ['user_providers', 'userId_status'],
      ['agents', 'ownerId_1'],
      ['agents', 'workspaceId_1'],
      ['agent_configs', 'channelId_1'],
      ['conversation_usage', 'channelId_unique'],
      ['conversation_usage', 'lastUpdated_-1'],
      ['conversation_usage', 'userId_lastUpdated'],
      ['conversation_usage', 'agentId_lastUpdated'],
      ['conversation_usage', 'workspaceId_lastUpdated'],
      ['conversation_usage', 'provider_lastUpdated'],
      ['user_credentials', 'userId_appId_unique'],
      ['volumes', 'volumeId_unique'],
      ['volumes', 'ownerId_1'],
      ['volumes', 'workspaceId_1'],
      ['models', 'modelId_unique'],
      ['models', 'provider_status'],
      ['agent_cores', 'coreId_unique'],
      ['mca_data', 'appId_scope_key_unique'],
      ['user_encryption_keys', 'userId_unique'],
      ['usage_windows', 'windowId_unique'],
      ['usage_windows', 'accountId_windowStart'],
      ['usage_windows', 'windowEnd_1'],
    ];

    for (const [col, name] of dropIndexes) {
      await dropIndexIfExists(db, col, name);
    }
  },
};

export default migration;
