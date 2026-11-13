/**
 * Every MongoDB index the backend relies on, in one place (GOV-4).
 *
 * Before this registry, indexes were created in ~30 services' ensureIndexes()
 * at boot, in a few constructors (fire-and-forget), and in migrations. Boot
 * created them BEFORE runMigrations, so a migration that needed to fix data
 * before a unique index, or that created the same key under another name, could
 * crash startup (IndexOptionsConflict 85 / IndexKeySpecsConflict 86).
 *
 * Now:
 *   - INDEXES below is the declared state per collection. Boot applies it once
 *     with ensureAllIndexes(db), AFTER runMigrations (server-bootstrap.ts).
 *   - Migrations still own data fixes and index drops/renames; when they create
 *     an index they use ensureIndex (same tolerance), and the final shape must
 *     also be declared here so a fresh DB and production converge.
 *   - Services' ensureIndexes() methods delegate here for their collections
 *     (tests and scripts call them); they no longer run at boot.
 *
 * Rules for editing:
 *   - NAMES ARE LOAD-BEARING. Production already has these indexes; declaring
 *     the same key under another name is a no-op that only logs a conflict, and
 *     an index with the same name but another spec is kept as is (unless the
 *     entry says `heal`). Most names below are Mongo's auto-generated ones
 *     (`field_1_other_-1`) because the old code passed no name.
 *   - To change an existing index's spec, either mark it `heal: true` (drop +
 *     recreate under the same name at boot) or write a migration.
 *   - The entries were derived from the old boot code plus the final state of
 *     every migration on a fresh DB (boot -> migrations -> boot, the production
 *     order). The trailing comment says who created each index first.
 *   - Prefix-redundant indexes (e.g. apps.ownerId_1 vs ownerId_1_name_1) are
 *     kept on purpose: dropping them is a separate, measured change.
 *
 * Sharding: workspace collections will be sharded by workspaceId and their
 * unique indexes must then be prefixed with it (docs/architecture/
 * sharding-by-workspace.md). Keys are NOT changed here yet; this file is where
 * that prefixing will happen.
 */

import type { Collection, CreateIndexesOptions, Db, Document, IndexSpecification } from 'mongodb'
import { COLLECTIONS, type CollectionName } from './collections'

export interface IndexDef {
  key: Record<string, 1 | -1>
  name: string
  unique?: boolean
  sparse?: boolean
  partialFilterExpression?: Document
  expireAfterSeconds?: number
  /**
   * The spec changed after production had the index under this same name:
   * drop and recreate it instead of keeping the old one (see
   * createIndexHealingConflict).
   */
  heal?: boolean
}

const SECONDS_PER_DAY = 24 * 60 * 60

export const INDEXES: { readonly [C in CollectionName]?: readonly IndexDef[] } = {
  [COLLECTIONS.migrations]: [
    { key: { name: 1 }, name: 'migration_name_unique', unique: true }, // runMigrations
  ],
  [COLLECTIONS.agentAppAccess]: [
    { key: { agentId: 1 }, name: 'agentId_1' }, // McaService
    { key: { appId: 1 }, name: 'appId_1' }, // McaService
    { key: { agentId: 1, appId: 1 }, name: 'agentId_1_appId_1', unique: true }, // McaService
  ],
  [COLLECTIONS.agentMailboxes]: [
    // One mailbox per agent — hard guarantee (tn_PcquTN30AawbK8uE)
    { key: { agentId: 1 }, name: 'agentId_unique', unique: true }, // AgentMailboxService
    // Address globally unique — no two agents share a mailbox, even via rename
    { key: { address: 1 }, name: 'address_unique', unique: true }, // AgentMailboxService
  ],
  [COLLECTIONS.burnedAddresses]: [
    // No-recycling: burned addresses are looked up before generating a name
    { key: { address: 1 }, name: 'address_unique', unique: true }, // AgentMailboxService
  ],
  [COLLECTIONS.agentAppInstallations]: [
    { key: { installationId: 1 }, name: 'installationId_1', unique: true }, // ensureStorageIndexes
    { key: { workspaceId: 1 }, name: 'workspaceId_1' }, // ensureStorageIndexes
    { key: { status: 1 }, name: 'status_1' }, // ensureStorageIndexes
  ],
  [COLLECTIONS.agentAppObjects]: [
    { key: { objectId: 1 }, name: 'objectId_1', unique: true }, // ensureStorageIndexes
    { key: { installationId: 1 }, name: 'installationId_1' }, // ensureStorageIndexes
  ],
  [COLLECTIONS.agentConfigs]: [
    { key: { channelId: 1 }, name: 'channelId_1' }, // 20260923_002
  ],
  [COLLECTIONS.agentCores]: [
    { key: { coreId: 1 }, name: 'coreId_unique', unique: true }, // 20260923_002
  ],
  [COLLECTIONS.agentProjectRelationships]: [
    { key: { projectId: 1, agentId: 1 }, name: 'projectId_1_agentId_1', unique: true }, // AutoplayService
    { key: { projectId: 1, playEnabled: 1 }, name: 'projectId_1_playEnabled_1' }, // AutoplayService
  ],
  [COLLECTIONS.agentSkillAccess]: [
    { key: { agentId: 1, skillId: 1 }, name: 'agentId_skillId_unique', unique: true }, // 20261017_002
    { key: { agentId: 1, order: 1 }, name: 'agentId_order' }, // 20261017_002
  ],
  [COLLECTIONS.agentUsageAccessLog]: [
    { key: { sessionUsageId: 1, at: -1 }, name: 'session_at' }, // 20260708_003
    { key: { adminUserId: 1, at: -1 }, name: 'admin_at' }, // 20260708_003
  ],
  [COLLECTIONS.agentUsageEventApplications]: [
    { key: { eventId: 1 }, name: 'eventId_unique', unique: true }, // 20260519_001
  ],
  [COLLECTIONS.agentUsageEvents]: [
    { key: { eventId: 1 }, name: 'eventId_unique', unique: true }, // 20260519_001
    { key: { sessionUsageId: 1, appliedAt: 1 }, name: 'sessionUsageId_appliedAt' }, // 20260519_001
  ],
  [COLLECTIONS.agentUsageRollupRuns]: [
    { key: { hourBucket: 1 }, name: 'hourBucket_unique', unique: true }, // 20260708_001
  ],
  [COLLECTIONS.agentUsageRollupsHourly]: [
    { key: { rollupId: 1 }, name: 'rollupId_unique', unique: true }, // 20260519_001
    { key: { hourBucket: 1, 'groupKey.userId': 1, 'groupKey.agentId': 1, 'groupKey.provider': 1, 'groupKey.workspaceId': 1 }, name: 'rollup_groupkey_unique', unique: true }, // 20260519_001
    { key: { 'groupKey.userId': 1, hourBucket: 1 }, name: 'user_hourBucket' }, // 20260519_001
    { key: { 'groupKey.workspaceId': 1, hourBucket: 1 }, name: 'workspace_hourBucket' }, // 20260519_001
  ],
  [COLLECTIONS.agentUsageRollupsUserHourly]: [
    { key: { rollupId: 1 }, name: 'rollupId_unique', unique: true }, // 20260519_001
    { key: { hourBucket: 1, 'groupKey.userId': 1, 'groupKey.workspaceId': 1 }, name: 'rollup_user_groupkey_unique', unique: true }, // 20260519_001
    { key: { 'groupKey.userId': 1, hourBucket: 1 }, name: 'user_hourBucket' }, // 20260519_001
  ],
  [COLLECTIONS.agentUsageSessions]: [
    { key: { startedAt: -1 }, name: 'startedAt_desc' }, // 20260708_002
    { key: { sessionUsageId: 1 }, name: 'sessionUsageId_unique', unique: true }, // 20260519_001
    { key: { userId: 1, agentId: 1, startedAt: -1 }, name: 'user_agent_started' }, // 20260519_001
    { key: { userId: 1, agentId: 1, provider: 1, startedAt: -1 }, name: 'user_agent_provider_started' }, // 20260519_001
    { key: { workspaceId: 1, startedAt: -1 }, name: 'workspace_started' }, // 20260519_001
    { key: { status: 1, startedAt: 1 }, name: 'status_started_reconcile' }, // 20260519_001
    { key: { channelId: 1, startedAt: -1 }, name: 'channel_started' }, // 20260519_001
    { key: { parentSessionUsageId: 1 }, name: 'parent_sparse', sparse: true }, // 20260519_001
    { key: { triggerKind: 1, startedAt: -1 }, name: 'triggerKind_started', sparse: true }, // 20260519_001
  ],
  [COLLECTIONS.agents]: [
    { key: { agentId: 1 }, name: 'agentId_unique', unique: true }, // 20260708_002
    { key: { ownerId: 1 }, name: 'ownerId_1' }, // 20260923_002
    { key: { workspaceId: 1 }, name: 'workspaceId_1' }, // 20260923_002
  ],
  [COLLECTIONS.apiTokens]: [
    { key: { tokenHash: 1 }, name: 'tokenHash_unique', unique: true, partialFilterExpression: { tokenHash: { $type: 'string' } } }, // 20261017_007
    { key: { tokenId: 1 }, name: 'tokenId_unique', unique: true, partialFilterExpression: { tokenId: { $type: 'string' } } }, // 20261017_007
    { key: { userId: 1 }, name: 'userId_1' }, // 20261017_007
  ],
  // NAV-NFR-2: pins are read per workspace zone; a window is anchored once per zone.
  [COLLECTIONS.navbarPins]: [
    { key: { workspaceId: 1, scope: 1, userId: 1, order: 1 }, name: 'workspaceId_1_scope_1_userId_1_order_1' }, // NavbarPinsService
    { key: { pinId: 1 }, name: 'pinId_1', unique: true }, // NavbarPinsService
    { key: { workspaceId: 1, key: 1 }, name: 'workspaceId_1_key_1_workspace', unique: true, partialFilterExpression: { scope: 'workspace' } }, // NavbarPinsService
    { key: { workspaceId: 1, userId: 1, key: 1 }, name: 'workspaceId_1_userId_1_key_1_personal', unique: true, partialFilterExpression: { scope: 'personal' } }, // NavbarPinsService
  ],
  [COLLECTIONS.apps]: [
    // MUW-REQ-27: a name is unique within the set it is visible in — shared
    // apps across the whole workspace, personal apps per owner (two members
    // may each have `gmail`). The old workspace-wide `ownerId_1_name_1` is
    // dropped by migration 20261102_004.
    { key: { ownerId: 1, name: 1 }, name: 'ownerId_1_name_1_shared', unique: true, partialFilterExpression: { scope: 'shared' } }, // McaService
    { key: { ownerId: 1, name: 1, installedBy: 1 }, name: 'ownerId_1_name_1_installedBy_1_personal', unique: true, partialFilterExpression: { scope: 'personal' } }, // McaService
    { key: { appId: 1 }, name: 'appId_1', unique: true }, // McaService
    { key: { ownerId: 1 }, name: 'ownerId_1' }, // McaService
  ],
  [COLLECTIONS.auditLogs]: [
    { key: { event: 1, timestamp: -1 }, name: 'event_1_timestamp_-1' }, // AuditLogger
    { key: { actorUserId: 1, timestamp: -1 }, name: 'actorUserId_1_timestamp_-1' }, // AuditLogger
    { key: { targetUserId: 1, timestamp: -1 }, name: 'targetUserId_1_timestamp_-1' }, // AuditLogger
  ],
  [COLLECTIONS.automateExecutions]: [
    { key: { executionId: 1 }, name: 'executionId_1', unique: true }, // AutomateModel
    { key: { starterId: 1, createdAt: -1 }, name: 'starterId_1_createdAt_-1' }, // AutomateModel
    { key: { starterId: 1, createdAt: -1, executionId: -1 }, name: 'starterId_1_createdAt_-1_executionId_-1' }, // AutomateModel
    { key: { createdBy: 1, createdAt: -1 }, name: 'createdBy_1_createdAt_-1' }, // AutomateModel
  ],
  [COLLECTIONS.automateStarters]: [
    { key: { starterId: 1 }, name: 'starterId_1', unique: true }, // AutomateModel
    { key: { workspaceId: 1, createdAt: -1 }, name: 'workspaceId_1_createdAt_-1' }, // AutomateModel
    { key: { 'action.projectId': 1 }, name: 'action.projectId_1' }, // AutomateModel
    { key: { 'action.agentId': 1 }, name: 'action.agentId_1' }, // AutomateModel
    { key: { 'trigger.tokenHash': 1 }, name: 'trigger.tokenHash_1', unique: true, sparse: true }, // AutomateModel
    // Unique on DBs created before 2026-10-14: legacy scheduler ids are per-user
    // counters, so two workspaces can import the same id. heal drops the stale one.
    { key: { 'trigger.schedulerTaskId': 1 }, name: 'trigger.schedulerTaskId_1', sparse: true, heal: true }, // AutomateModel
    { key: { 'trigger.type': 1, enabled: 1, 'trigger.nextRunAt': 1 }, name: 'trigger.type_1_enabled_1_trigger.nextRunAt_1', sparse: true }, // AutomateModel
    { key: { workspaceId: 1, idempotencyKey: 1 }, name: 'starters_idempotency', unique: true, partialFilterExpression: { idempotencyKey: { $exists: true } } }, // AutomateModel
    { key: { ownerFlowId: 1 }, name: 'ownerFlowId_1', sparse: true }, // AutomateModel
    { key: { workspaceId: 1, order: 1 }, name: 'workspaceId_1_order_1' }, // 20260629_001
    { key: { projectId: 1 }, name: 'projectId_1' }, // 20260629_001
    { key: { agentId: 1 }, name: 'agentId_1' }, // 20260629_001
    { key: { 'config.tokenHash': 1 }, name: 'config.tokenHash_1', unique: true, sparse: true }, // 20260629_001
    { key: { 'config.schedulerTaskId': 1 }, name: 'config.schedulerTaskId_1', unique: true, sparse: true }, // 20260629_001
  ],
  [COLLECTIONS.automateWebhookCalls]: [
    { key: { callId: 1 }, name: 'callId_1', unique: true }, // AutomateModel
    { key: { starterId: 1, createdAt: -1 }, name: 'starterId_1_createdAt_-1' }, // AutomateModel
    { key: { taskId: 1 }, name: 'taskId_1' }, // AutomateModel
    { key: { discriminator: 1 }, name: 'discriminator_1', sparse: true }, // AutomateModel
  ],
  [COLLECTIONS.billingAccessRequests]: [
    { key: { userId: 1, type: 1 }, name: 'billing_access_req_one_pending', unique: true, partialFilterExpression: { status: 'pending' } }, // ensureBillingIndexes
    { key: { status: 1 }, name: 'billing_access_req_status' }, // ensureBillingIndexes
    { key: { userId: 1 }, name: 'billing_access_req_userId' }, // ensureBillingIndexes
  ],
  [COLLECTIONS.billingCustomers]: [
    { key: { stripeCustomerId: 1 }, name: 'billing_customer_stripeId_unique', unique: true }, // ensureBillingIndexes
  ],
  [COLLECTIONS.billingHourBoosts]: [
    // Partial so purchase boosts (accessRequestId null) don't collide; older DBs
    // had it non-partial (TER-596 I1), hence heal.
    { key: { accessRequestId: 1 }, name: 'billing_boost_request_unique', unique: true, partialFilterExpression: { accessRequestId: { $type: 'string' } }, heal: true }, // ensureBillingIndexes
    { key: { subscriptionId: 1, status: 1 }, name: 'billing_boost_sub_status' }, // ensureBillingIndexes
    { key: { userId: 1 }, name: 'billing_boost_userId' }, // ensureBillingIndexes
  ],
  [COLLECTIONS.billingHourLedger]: [
    { key: { subscriptionId: 1, hourBucket: 1 }, name: 'billing_ledger_sub_bucket_unique', unique: true }, // ensureBillingIndexes
    { key: { userId: 1 }, name: 'billing_ledger_userId' }, // ensureBillingIndexes
    { key: { trackerRunId: 1 }, name: 'billing_ledger_runId' }, // ensureBillingIndexes
  ],
  [COLLECTIONS.billingInvoices]: [
    { key: { subscriptionId: 1 }, name: 'billing_inv_subId' }, // ensureBillingIndexes
    { key: { userId: 1 }, name: 'billing_inv_userId' }, // ensureBillingIndexes
    { key: { status: 1 }, name: 'billing_inv_status' }, // ensureBillingIndexes
    // One SUBSCRIPTION invoice per period; partial on kind so boost invoices
    // never collide. Older DBs had it full-unique (TER-596 I1), hence heal.
    { key: { subscriptionId: 1, periodStart: 1, periodEnd: 1 }, name: 'billing_inv_period_unique', unique: true, partialFilterExpression: { kind: 'subscription' }, heal: true }, // ensureBillingIndexes
    { key: { userId: 1, status: 1 }, name: 'billing_inv_user_status' }, // 20260622_001
  ],
  [COLLECTIONS.billingPeriodSnapshots]: [
    { key: { subscriptionId: 1, periodStart: 1, periodEnd: 1 }, name: 'billing_snapshot_period_unique', unique: true }, // ensureBillingIndexes
    { key: { userId: 1 }, name: 'billing_snapshot_userId' }, // ensureBillingIndexes
  ],
  [COLLECTIONS.billingSubscriptions]: [
    { key: { userId: 1 }, name: 'billing_sub_userId' }, // ensureBillingIndexes
    { key: { planId: 1 }, name: 'billing_sub_planId' }, // ensureBillingIndexes
    { key: { status: 1 }, name: 'billing_sub_status' }, // ensureBillingIndexes
    { key: { teamId: 1 }, name: 'billing_sub_teamId' }, // ensureBillingIndexes
    { key: { userId: 1 }, name: 'billing_sub_one_active', unique: true, partialFilterExpression: { status: 'active' } }, // ensureBillingIndexes
    { key: { lastBilledHourBucket: 1 }, name: 'lastBilledHourBucket_sparse', sparse: true }, // 20260527_001
  ],
  [COLLECTIONS.billingTeams]: [
    { key: { memberIds: 1 }, name: 'billing_teams_memberIds' }, // ensureBillingIndexes
    { key: { planId: 1 }, name: 'billing_teams_planId' }, // ensureBillingIndexes
    { key: { status: 1 }, name: 'billing_teams_status' }, // ensureBillingIndexes
  ],
  [COLLECTIONS.boardDailyStats]: [
    { key: { boardId: 1, date: 1 }, name: 'boardId_date_unique', unique: true }, // BoardEventService
    { key: { projectId: 1, date: -1 }, name: 'projectId_date_desc' }, // BoardEventService
    { key: { workspaceId: 1, date: -1 }, name: 'workspaceId_date_desc' }, // BoardEventService
    { key: { date: -1 }, name: 'date_desc' }, // BoardEventService
  ],
  [COLLECTIONS.boardEvents]: [
    { key: { boardId: 1, timestamp: -1 }, name: 'boardId_timestamp_desc' }, // BoardEventService
    { key: { taskId: 1, timestamp: -1 }, name: 'taskId_timestamp_desc' }, // BoardEventService
    { key: { projectId: 1, timestamp: -1 }, name: 'projectId_timestamp_desc' }, // BoardEventService
    { key: { workspaceId: 1, timestamp: -1 }, name: 'workspaceId_timestamp_desc' }, // BoardEventService
    { key: { eventType: 1, timestamp: -1 }, name: 'eventType_timestamp_desc' }, // BoardEventService
    { key: { actor: 1, timestamp: -1 }, name: 'actor_timestamp_desc' }, // BoardEventService
  ],
  [COLLECTIONS.boardSubscriptions]: [
    { key: { boardId: 1 }, name: 'boardId_lookup' }, // BoardSubscriptionService
    { key: { channelId: 1 }, name: 'channelId_lookup' }, // BoardSubscriptionService
    { key: { boardId: 1, channelId: 1 }, name: 'boardId_channelId_unique', unique: true }, // BoardSubscriptionService
  ],
  [COLLECTIONS.boards]: [
    { key: { boardId: 1 }, name: 'boardId_1', unique: true }, // BoardService
    { key: { projectId: 1 }, name: 'projectId_1', unique: true }, // BoardService
  ],
  [COLLECTIONS.channelMessages]: [
    { key: { channelId: 1, 'content.type': 1, timestamp: -1 }, name: 'channelId_contentType_timestamp' }, // 20260917_002
    { key: { userId: 1, role: 1, timestamp: 1 }, name: 'userId_1_role_1_timestamp_1' }, // 20260917_003
    { key: { messageId: 1 }, name: 'messageId_unique', unique: true }, // 20261017_002
    { key: { channelId: 1, timestamp: -1, messageId: -1 }, name: 'channelId_timestamp_messageId' }, // 20261017_002
  ],
  [COLLECTIONS.channelSubscriptions]: [
    { key: { subscriberChannelId: 1, observedChannelId: 1 }, name: 'unique_subscription', unique: true }, // PubSubService.init
    { key: { observedChannelId: 1 }, name: 'observed_channel_lookup' }, // PubSubService.init
    { key: { subscriberChannelId: 1 }, name: 'subscriber_channel_lookup' }, // PubSubService.init
  ],
  [COLLECTIONS.channels]: [
    { key: { userId: 1, updatedAt: -1 }, name: 'userId_1_updatedAt_-1' }, // ChannelManager
    { key: { channelId: 1 }, name: 'channelId_1', unique: true }, // ChannelManager
    { key: { workspaceId: 1, lastMessageAt: -1, channelId: 1 }, name: 'workspaceId_1_lastMessageAt_-1_channelId_1' }, // ChannelManager
  ],
  [COLLECTIONS.compactions]: [
    { key: { sessionId: 1, _id: -1 }, name: 'sessionId_1__id_-1' }, // MongoSessionStore ctor
  ],
  [COLLECTIONS.consentAuditLog]: [
    { key: { userId: 1, timestamp: -1 }, name: 'userId_1_timestamp_-1' }, // profile consent audit (task_047a4844b9103db3)
    { key: { timestamp: 1 }, name: 'timestamp_1' }, // profile consent audit (task_047a4844b9103db3)
  ],
  [COLLECTIONS.costsAccessLogs]: [
    // Costs API access audit (task_6de67c22b163387a) — who queried the
    // financial surface, when, with which key fingerprint.
    { key: { timestamp: -1 }, name: 'timestamp_-1' }, // CostsAccessLogger
    { key: { keyFingerprint: 1, timestamp: -1 }, name: 'keyFingerprint_1_timestamp_-1' }, // CostsAccessLogger
    { key: { endpoint: 1, timestamp: -1 }, name: 'endpoint_1_timestamp_-1' }, // CostsAccessLogger
  ],
  [COLLECTIONS.conversationEvaluations]: [
    { key: { channelId: 1, 'evaluator.promptVersion': 1 }, name: 'channelId_1_evaluator.promptVersion_1', unique: true }, // evaluator record
    { key: { scenarioFingerprint: 1 }, name: 'scenarioFingerprint_1' }, // evaluator record
  ],
  [COLLECTIONS.conversationFeedback]: [
    { key: { conversationId: 1, userId: 1 }, name: 'conversationId_1_userId_1', unique: true }, // FeedbackService
    { key: { workspaceId: 1, createdAt: -1 }, name: 'workspaceId_1_createdAt_-1' }, // FeedbackService
  ],
  [COLLECTIONS.conversationUsage]: [
    { key: { channelId: 1 }, name: 'channelId_unique', unique: true }, // 20260923_002
    { key: { userId: 1, lastUpdated: -1 }, name: 'userId_lastUpdated' }, // 20260923_002
    { key: { agentId: 1, lastUpdated: -1 }, name: 'agentId_lastUpdated' }, // 20260923_002
    { key: { workspaceId: 1, lastUpdated: -1 }, name: 'workspaceId_lastUpdated' }, // 20260923_002
    { key: { provider: 1, lastUpdated: -1 }, name: 'provider_lastUpdated' }, // 20260923_002
    { key: { lastUpdated: -1 }, name: 'lastUpdated_-1' }, // 20260923_002
  ],
  [COLLECTIONS.deletionLog]: [
    { key: { deletionLogId: 1 }, name: 'unique_deletion_log_id', unique: true }, // DeletionLogService (never ran at boot: new in prod)
    { key: { collection: 1, timestamp: -1 }, name: 'collection_timestamp' }, // DeletionLogService (never ran at boot: new in prod)
    { key: { actor: 1, timestamp: -1 }, name: 'actor_timestamp' }, // DeletionLogService (never ran at boot: new in prod)
    { key: { timestamp: 1 }, name: 'timestamp_asc' }, // DeletionLogService (never ran at boot: new in prod)
  ],
  [COLLECTIONS.emailAuditLog]: [
    { key: { 'attempts.sentAt': -1 }, name: 'attempts.sentAt_-1' }, // EmailService
  ],
  [COLLECTIONS.emailVerifications]: [
    { key: { tokenHash: 1 }, name: 'tokenHash_1', unique: true }, // EmailVerificationService
    { key: { userId: 1 }, name: 'userId_1' }, // EmailVerificationService
    { key: { expiresAt: 1 }, name: 'expiresAt_1', expireAfterSeconds: 0 }, // EmailVerificationService
  ],
  [COLLECTIONS.passwordResets]: [
    { key: { tokenHash: 1 }, name: 'tokenHash_1', unique: true }, // PasswordResetService
    { key: { email: 1 }, name: 'email_1' }, // PasswordResetService (latest-per-email replace)
    { key: { expiresAt: 1 }, name: 'expiresAt_1', expireAfterSeconds: 0 }, // PasswordResetService
  ],
  [COLLECTIONS.featureFlagAuditLog]: [
    { key: { key: 1, timestamp: -1 }, name: 'audit_key_time' }, // FeatureFlagService
    { key: { actor: 1, timestamp: -1 }, name: 'audit_actor_time' }, // FeatureFlagService
    { key: { timestamp: -1 }, name: 'audit_time' }, // FeatureFlagService
  ],
  [COLLECTIONS.featureFlagOverrides]: [
    { key: { key: 1, targetType: 1, targetId: 1 }, name: 'override_unique', unique: true }, // FeatureFlagService
    { key: { key: 1 }, name: 'override_key_lookup' }, // FeatureFlagService
    { key: { targetType: 1, targetId: 1 }, name: 'override_target_lookup' }, // FeatureFlagService
  ],
  [COLLECTIONS.featureFlags]: [
    { key: { key: 1 }, name: 'flag_key_unique', unique: true }, // FeatureFlagService
  ],
  [COLLECTIONS.flowEventTriggers]: [
    { key: { flowId: 1 }, name: 'flowId_1', unique: true }, // FlowEventService
    { key: { topic: 1 }, name: 'topic_1' }, // FlowEventService
  ],
  [COLLECTIONS.flowWebhookInvocations]: [
    { key: { flowId: 1, timestamp: -1 }, name: 'flowId_1_timestamp_-1' }, // FlowWebhookService
  ],
  [COLLECTIONS.githubWebhookDeliveries]: [
    { key: { expiresAt: 1 }, name: 'expiresAt_1', expireAfterSeconds: 0 }, // GitHubAppService ctor
  ],
  [COLLECTIONS.latitudeSignalIndex]: [
    { key: { traceId: 1 }, name: 'trace_unique', unique: true }, // LatitudeSignalIndex
    // 30 days: a recent session still shows its badge; expiry just drops it.
    { key: { updatedAt: 1 }, name: 'signal_ttl', expireAfterSeconds: 30 * SECONDS_PER_DAY }, // LatitudeSignalIndex
  ],
  [COLLECTIONS.latitudeWebhookDeliveries]: [
    { key: { deliveryId: 1 }, name: 'delivery_unique', unique: true }, // LatitudeSignalIndex
    // Dedupe window for webhook redeliveries.
    { key: { createdAt: 1 }, name: 'delivery_ttl', expireAfterSeconds: SECONDS_PER_DAY }, // LatitudeSignalIndex
  ],
  [COLLECTIONS.leaderLocks]: [
    { key: { name: 1 }, name: 'name_unique', unique: true }, // 20260520_001
    { key: { expiresAt: 1 }, name: 'expiresAt_ttl', expireAfterSeconds: 0 }, // 20260520_001
  ],
  [COLLECTIONS.llmUsage]: [
    { key: { sessionUsageId: 1 }, name: 'sessionUsageId_sparse', sparse: true }, // 20260519_001
    { key: { messageId: 1 }, name: 'messageId_lookup' }, // 20260630_004
    { key: { userId: 1, timestamp: -1 }, name: 'userId_timestamp' }, // 20261017_002
  ],
  [COLLECTIONS.mcaCatalog]: [
    { key: { mcaId: 1 }, name: 'mcaId_1', unique: true }, // McaService
  ],
  [COLLECTIONS.mcaData]: [
    { key: { appId: 1, scope: 1, key: 1 }, name: 'appId_scope_key_unique', unique: true }, // 20260923_002
  ],
  [COLLECTIONS.mcaOauthStates]: [
    { key: { state: 1 }, name: 'state_1', unique: true }, // McaOAuth
    { key: { expiresAt: 1 }, name: 'expiresAt_1', expireAfterSeconds: 0 }, // McaOAuth
  ],
  [COLLECTIONS.mcaSubscriptions]: [
    { key: { appId: 1, status: 1 }, name: 'appId_1_status_1' }, // McaConnectionManager
    { key: { subscriptionId: 1 }, name: 'subscriptionId_1', unique: true }, // McaConnectionManager
    { key: { 'subscriber.channelId': 1 }, name: 'subscriber.channelId_1' }, // McaConnectionManager
    { key: { 'options.expiresAt': 1 }, name: 'options.expiresAt_1', expireAfterSeconds: 0 }, // McaConnectionManager
  ],
  [COLLECTIONS.mcaToolHealth]: [
    { key: { mcaId: 1, tool: 1 }, name: 'mcaId_tool_unique', unique: true }, // 20260702_001
  ],
  [COLLECTIONS.messageActions]: [
    { key: { messageId: 1, createdAt: -1 }, name: 'messageId_1_createdAt_-1' }, // FeedbackService
    { key: { conversationId: 1, createdAt: -1 }, name: 'conversationId_1_createdAt_-1' }, // FeedbackService
  ],
  [COLLECTIONS.messageFeedback]: [
    { key: { messageId: 1, userId: 1 }, name: 'messageId_1_userId_1', unique: true }, // FeedbackService
    { key: { conversationId: 1, createdAt: -1 }, name: 'conversationId_1_createdAt_-1' }, // FeedbackService
    { key: { agentId: 1, createdAt: -1 }, name: 'agentId_1_createdAt_-1' }, // FeedbackService
    { key: { createdAt: 1 }, name: 'createdAt_asc' }, // 20260708_002
  ],
  [COLLECTIONS.models]: [
    { key: { modelId: 1 }, name: 'modelId_unique', unique: true }, // 20260923_002
    { key: { provider: 1, status: 1 }, name: 'provider_status' }, // 20260923_002
  ],
  [COLLECTIONS.oauthStates]: [
    { key: { state: 1 }, name: 'state_1', unique: true }, // GoogleAuth, MicrosoftAuth, GitHubAuth
    { key: { expiresAt: 1 }, name: 'expiresAt_1', expireAfterSeconds: 0 }, // GoogleAuth, MicrosoftAuth, GitHubAuth
  ],
  [COLLECTIONS.projects]: [
    // Same name as boot always used (and migration 20261017_002 now uses), so
    // production and fresh DBs agree.
    { key: { projectId: 1 }, name: 'projectId_1', unique: true }, // BoardService
    { key: { workspaceId: 1 }, name: 'workspaceId_1' }, // BoardService, ProjectService ctor
    { key: { status: 1 }, name: 'status_1' }, // BoardService
    { key: { boardId: 1 }, name: 'boardId_1', unique: true }, // ProjectService ctor
  ],
  [COLLECTIONS.rateLimitCounters]: [
    { key: { expiresAt: 1 }, name: 'rate_limit_counters_ttl', expireAfterSeconds: 0 }, // 20260617_002
  ],
  [COLLECTIONS.remoteDevices]: [
    { key: { deviceId: 1 }, name: 'deviceId_unique', unique: true }, // 20261018_001
    { key: { appId: 1 }, name: 'appId_1' }, // 20261018_001 — one device per app instance (spec: multi: true installs)
    { key: { tokenHash: 1 }, name: 'tokenHash_1' }, // 20261018_001 — fast path for hello key lookup
    { key: { workspaceId: 1, status: 1 }, name: 'workspaceId_1_status_1' }, // 20261018_001 — app panel / health (REQ-13)
    { key: { ownerId: 1 }, name: 'ownerId_1' }, // 20261018_001
  ],
  [COLLECTIONS.remoteDeviceBindings]: [
    { key: { deviceId: 1, appId: 1 }, name: 'deviceId_appId_unique', unique: true }, // 20261020_001 — one binding per (device, app)
    { key: { appId: 1, status: 1 }, name: 'appId_status' }, // 20261020_001 — lookup by app instance
    { key: { deviceId: 1, status: 1 }, name: 'deviceId_status' }, // 20261020_001 — lookup by device
    { key: { workspaceId: 1 }, name: 'workspaceId_1' }, // 20261020_001 — workspace-scoped queries
  ],
  [COLLECTIONS.sessionMessages]: [
    { key: { sessionId: 1, _id: 1 }, name: 'sessionId_1__id_1' }, // MongoSessionStore ctor
    { key: { 'info.id': 1 }, name: 'info.id_1' }, // MongoSessionStore ctor
    { key: { 'info.sessionID': 1, 'info.role': 1, 'info.meta.queueState': 1 }, name: 'info.sessionID_role_queueState' }, // 20260917_001
  ],
  [COLLECTIONS.sessions]: [
    { key: { userId: 1, 'time.updated': -1 }, name: 'userId_1_time.updated_-1' }, // MongoSessionStore ctor
    { key: { id: 1 }, name: 'id_unique', unique: true }, // 20261017_002
  ],
  [COLLECTIONS.sharedFiles]: [
    { key: { shareId: 1 }, name: 'shareId_1', unique: true }, // ShareService (never ran at boot: new in prod)
    { key: { ownerId: 1 }, name: 'ownerId_1' }, // ShareService (never ran at boot: new in prod)
  ],
  [COLLECTIONS.skills]: [
    { key: { skillId: 1 }, name: 'skillId_unique', unique: true }, // 20261017_002
    { key: { workspaceId: 1, name: 1 }, name: 'workspaceId_name' }, // 20261017_002
  ],
  [COLLECTIONS.subscriptionsAgent]: [
    { key: { topic: 1 }, name: 'topic_lookup' }, // MCAEventSubscriptionService.init
    { key: { agentId: 1 }, name: 'agent_lookup' }, // MCAEventSubscriptionService.init
  ],
  [COLLECTIONS.subscriptionsChannel]: [
    { key: { topic: 1 }, name: 'topic_lookup' }, // MCAEventSubscriptionService.init
    { key: { channelId: 1 }, name: 'channel_lookup' }, // MCAEventSubscriptionService.init
    { key: { topic: 1, channelId: 1 }, name: 'topic_channel_lookup' }, // MCAEventSubscriptionService.init
    { key: { lastActivityAt: 1 }, name: 'sliding_ttl', expireAfterSeconds: SECONDS_PER_DAY }, // 20260318_001
  ],
  [COLLECTIONS.subscriptionsCorrelation]: [
    { key: { subscriptionId: 1, correlationValue: 1 }, name: 'unique_correlation', unique: true }, // MCAEventSubscriptionService.init
    { key: { channelId: 1 }, name: 'channel_lookup' }, // MCAEventSubscriptionService.init
  ],
  [COLLECTIONS.tasks]: [
    { key: { taskId: 1 }, name: 'taskId_1', unique: true }, // BoardService
    { key: { boardId: 1, columnId: 1, position: 1 }, name: 'boardId_1_columnId_1_position_1' }, // BoardService
    { key: { boardId: 1, assignedAgentId: 1 }, name: 'boardId_1_assignedAgentId_1' }, // BoardService
    { key: { channelId: 1 }, name: 'channelId_1', sparse: true }, // BoardService
    { key: { parentTaskId: 1 }, name: 'parentTaskId_1', sparse: true }, // BoardService
    { key: { workflowExecutionId: 1 }, name: 'workflow_execution_lookup', sparse: true }, // BoardService
  ],
  [COLLECTIONS.terosProviderConfigs]: [
    { key: { isDefault: 1 }, name: 'teros_cfg_isDefault', unique: true, sparse: true }, // ensureBillingIndexes
    { key: { name: 1 }, name: 'teros_cfg_name' }, // ensureBillingIndexes
  ],
  [COLLECTIONS.todoNodes]: [
    { key: { workspaceId: 1, nodeId: 1 }, name: 'workspaceId_1_nodeId_1', unique: true }, // todo action, lazy
    { key: { workspaceId: 1, parentId: 1, position: 1 }, name: 'workspaceId_1_parentId_1_position_1' }, // todo action, lazy
    { key: { workspaceId: 1, completed: 1 }, name: 'workspaceId_1_completed_1' }, // todo action, lazy
    { key: { workspaceId: 1, plannedFor: 1, dayOrder: 1 }, name: 'workspaceId_1_plannedFor_1_dayOrder_1' }, // todo plan-node / get-day, lazy
    { key: { workspaceId: 1, 'assignee.kind': 1, 'assignee.id': 1, state: 1 }, name: 'workspaceId_1_assignee_1_state_1' }, // TodoAutoplayService queue (TODOAP)
    { key: { workspaceId: 1, 'reviewer.kind': 1, 'reviewer.id': 1, state: 1 }, name: 'workspaceId_1_reviewer_1_state_1' }, // todo get-tree reviewer filter (TODORV)
    { key: { workspaceId: 1, channelId: 1 }, name: 'workspaceId_1_channelId_1' }, // todo running hook (TODOAP)
  ],
  [COLLECTIONS.todoAutoplayRunners]: [
    { key: { workspaceId: 1, agentId: 1 }, name: 'workspaceId_1_agentId_1', unique: true }, // TodoAutoplayService (TODOAP)
    { key: { workspaceId: 1, playEnabled: 1 }, name: 'workspaceId_1_playEnabled_1' }, // TodoAutoplayService (TODOAP)
  ],
  [COLLECTIONS.todoAutoplayState]: [
    // One global play/pause doc per workspace (TODOAP-REQ-30)
    { key: { workspaceId: 1 }, name: 'workspaceId_1', unique: true }, // TodoAutoplayService (TODOAP)
  ],
  [COLLECTIONS.todoSubscriptions]: [
    { key: { workspaceId: 1 }, name: 'workspaceId_lookup' }, // TodoSubscriptionService
    { key: { channelId: 1 }, name: 'channelId_lookup' }, // TodoSubscriptionService
    { key: { workspaceId: 1, channelId: 1 }, name: 'workspaceId_channelId_unique', unique: true }, // TodoSubscriptionService
  ],
  [COLLECTIONS.toolExecutions]: [
    { key: { startedAt: -1 }, name: 'startedAt_desc' }, // 20260708_002
    { key: { workspaceId: 1, startedAt: -1 }, name: 'workspace_startedAt' }, // 20260708_002
    { key: { toolExecutionId: 1 }, name: 'toolExecutionId_unique', unique: true }, // 20260519_001
    { key: { sessionUsageId: 1, stepIndex: 1, toolCallIndex: 1 }, name: 'session_step_toolcall' }, // 20260519_001
    { key: { userId: 1, toolName: 1, startedAt: -1 }, name: 'user_tool_started' }, // 20260519_001
    { key: { mcaId: 1, startedAt: -1 }, name: 'mca_started_sparse', sparse: true }, // 20260519_001
    { key: { status: 1, startedAt: 1 }, name: 'status_started_reconcile' }, // 20260519_001
  ],
  [COLLECTIONS.transcriptionLogs]: [
    { key: { timestamp: -1 }, name: 'timestamp_-1' }, // TranscriptionLogService
    { key: { userId: 1, timestamp: -1 }, name: 'userId_1_timestamp_-1' }, // TranscriptionLogService
    { key: { provider: 1, timestamp: -1 }, name: 'provider_1_timestamp_-1' }, // TranscriptionLogService
    { key: { channelId: 1, timestamp: -1 }, name: 'channelId_1_timestamp_-1' }, // TranscriptionLogService
  ],
  [COLLECTIONS.usageWindows]: [
    { key: { windowId: 1 }, name: 'windowId_unique', unique: true }, // 20260923_002
    { key: { accountId: 1, windowStart: -1 }, name: 'accountId_windowStart' }, // 20260923_002
    { key: { windowEnd: 1 }, name: 'windowEnd_1' }, // 20260923_002
  ],
  [COLLECTIONS.terminalSleepingSessions]: [
    { key: { workspaceId: 1, terminalId: 1 }, name: 'workspaceId_terminalId_unique', unique: true }, // terminal/sleep-store.ts
    { key: { stackId: 1 }, name: 'stackId_1' }, // terminal/sleep-store.ts
  ],
  [COLLECTIONS.userCredentials]: [
    { key: { userId: 1, appId: 1 }, name: 'userId_appId_unique', unique: true }, // 20260923_002
  ],
  [COLLECTIONS.userDesktopState]: [
    { key: { userId: 1, workspaceId: 1 }, name: 'userId_1_workspaceId_1', unique: true }, // DesktopStateService ctor
  ],
  [COLLECTIONS.userEncryptionKeys]: [
    { key: { userId: 1 }, name: 'userId_unique', unique: true }, // 20260923_002
  ],
  [COLLECTIONS.userIdentities]: [
    { key: { type: 1, providerUserId: 1 }, name: 'type_1_providerUserId_1', unique: true }, // IdentityService
    { key: { userId: 1 }, name: 'userId_1' }, // IdentityService
    { key: { type: 1, email: 1 }, name: 'type_1_email_1' }, // IdentityService
  ],
  [COLLECTIONS.userProviders]: [
    { key: { providerId: 1 }, name: 'providerId_unique', unique: true }, // 20260923_002
    { key: { userId: 1, status: 1 }, name: 'userId_status' }, // 20260923_002
    { key: { userId: 1 }, name: 'userId_teros_unique', unique: true, partialFilterExpression: { providerType: 'teros' } }, // 20261017_004
    { key: { userId: 1 }, name: 'userId_default_unique', unique: true, partialFilterExpression: { isDefault: true } }, // 20261017_004
  ],
  [COLLECTIONS.userSessions]: [
    { key: { tokenHash: 1 }, name: 'tokenHash_1', unique: true }, // SessionService
    { key: { userId: 1 }, name: 'userId_1' }, // SessionService
    { key: { expiresAt: 1 }, name: 'expiresAt_1', expireAfterSeconds: 0 }, // SessionService
    { key: { status: 1, expiresAt: 1 }, name: 'status_1_expiresAt_1' }, // SessionService
  ],
  [COLLECTIONS.users]: [
    { key: { userId: 1 }, name: 'userId_1', unique: true }, // UserService
    { key: { 'profile.email': 1 }, name: 'profile.email_1', unique: true }, // UserService
    { key: { status: 1 }, name: 'status_1' }, // UserService
    { key: { deletedAt: 1 }, name: 'deletedAt_1', sparse: true }, // UserService
  ],
  [COLLECTIONS.voiceSessions]: [
    { key: { channelId: 1, agentId: 1 }, name: 'channelId_agentId_unique', unique: true }, // 20261002_001
    { key: { userId: 1, lastActivityAt: -1 }, name: 'userId_lastActivityAt' }, // 20261002_001
  ],
  [COLLECTIONS.voiceTelemetrySessions]: [
    { key: { recordId: 1 }, name: 'recordId_unique', unique: true }, // 20261002_002
    { key: { channelId: 1, startedAt: -1 }, name: 'channelId_startedAt' }, // 20261002_002
    { key: { userId: 1, startedAt: -1 }, name: 'userId_startedAt' }, // 20261002_002
  ],
  [COLLECTIONS.volumes]: [
    { key: { volumeId: 1 }, name: 'volumeId_unique', unique: true }, // 20260923_002
    { key: { ownerId: 1 }, name: 'ownerId_1' }, // 20260923_002
    { key: { workspaceId: 1 }, name: 'workspaceId_1' }, // 20260923_002
  ],
  [COLLECTIONS.workspaceMembers]: [
    { key: { userId: 1 }, name: 'userId_1' }, // WorkspaceService
    { key: { email: 1, status: 1 }, name: 'email_1_status_1' }, // WorkspaceService
    { key: { workspaceId: 1, userId: 1 }, name: 'workspaceId_userId_unique', unique: true, partialFilterExpression: { userId: { $type: 'string' } } }, // 20261017_003
    { key: { workspaceId: 1, email: 1 }, name: 'workspaceId_email_pending_unique', unique: true, partialFilterExpression: { status: 'pending' } }, // 20261017_003
  ],
  [COLLECTIONS.workspaces]: [
    { key: { workspaceId: 1 }, name: 'workspaceId_1', unique: true }, // WorkspaceService
    { key: { ownerId: 1 }, name: 'ownerId_1' }, // WorkspaceService
    { key: { volumeId: 1 }, name: 'volumeId_1', unique: true, sparse: true }, // WorkspaceService
    { key: { status: 1 }, name: 'status_1' }, // WorkspaceService
    { key: { ownerId: 1 }, name: 'ownerId_private_unique', unique: true, partialFilterExpression: { type: 'private' } }, // 20261017_004
  ],
}

/**
 * Indexes of each dynamic `agent_app_storage_*` collection (one per Agent App
 * storage collection, created at runtime on the first storage_put — see
 * services/agent-apps/storage-indexes.ts). Not in INDEXES: the names are not
 * known at boot.
 */
export const AGENT_APP_STORAGE_INDEXES: readonly IndexDef[] = [
  { key: { _installationId: 1, _documentId: 1 }, name: '_installationId_1__documentId_1', unique: true },
  { key: { _installationId: 1 }, name: '_installationId_1' },
]

// ============================================================================
// APPLYING
// ============================================================================

const INDEX_OPTIONS_CONFLICT = 85
const INDEX_KEY_SPECS_CONFLICT = 86
const DUPLICATE_KEY = 11000
const INDEX_NOT_FOUND = 27
const NAMESPACE_NOT_FOUND = 26

function errorCode(err: unknown): number | undefined {
  return (err as { code?: number }).code
}

/** createIndex options of a registry entry. */
export function indexOptions(def: IndexDef): CreateIndexesOptions & { name: string } {
  const { key: _key, heal: _heal, ...options } = def
  return options
}

/**
 * createIndex that cannot abort boot on legacy data: an equivalent index
 * created earlier under another name or options (codes 85/86) is kept, and a
 * unique index over duplicate values falls back to a non-unique
 * `<name>_nonunique` with a warning instead of failing startup.
 */
async function ensureIndexOn<T extends Document>(
  col: Collection<T>,
  key: IndexSpecification,
  options: CreateIndexesOptions & { name: string },
): Promise<void> {
  try {
    await col.createIndex(key, options)
  } catch (err) {
    const code = errorCode(err)
    if (code === INDEX_OPTIONS_CONFLICT || code === INDEX_KEY_SPECS_CONFLICT) {
      console.warn(`[Indexes] ${col.collectionName}.${options.name}: an equivalent index already exists — kept`)
      return
    }
    if (code === DUPLICATE_KEY && options.unique) {
      await col.createIndex(key, { name: `${options.name}_nonunique` })
      console.warn(
        `[Indexes] ${col.collectionName}.${options.name}: duplicates found — created NON-unique ${options.name}_nonunique; investigate`,
      )
      return
    }
    throw err
  }
}

/** ensureIndexOn by collection name (the helper migrations use). */
export async function ensureIndex(
  db: Db,
  collection: string,
  key: IndexSpecification,
  options: CreateIndexesOptions & { name: string },
): Promise<void> {
  await ensureIndexOn(db.collection(collection), key, options)
}

/** Drop an index (and its `_nonunique` fallback) if present. */
export async function dropIndexIfExists(db: Db, collection: string, name: string): Promise<void> {
  for (const candidate of [name, `${name}_nonunique`]) {
    try {
      await db.collection(collection).dropIndex(candidate)
      console.log(`[Indexes] Dropped ${collection}.${candidate}`)
    } catch (err) {
      const code = errorCode(err)
      if (code !== INDEX_NOT_FOUND && code !== NAMESPACE_NOT_FOUND) throw err
    }
  }
}

/**
 * createIndex that heals a name collision when an index's SPEC changed.
 *
 * Mongo rejects createIndex when an index with the same name exists but a
 * different spec: IndexKeySpecsConflict (86) when the key fields or uniqueness
 * differ, IndexOptionsConflict (85) when only the options differ (e.g. adding a
 * partialFilterExpression). This drops the conflicting index and recreates it
 * with the new spec. When the conflict was an equivalent index under ANOTHER
 * name (the drop finds nothing), that index is kept. On a fresh DB or a re-run
 * (same spec) it's a plain, idempotent createIndex with no drop.
 */
export async function createIndexHealingConflict<T extends Document>(
  col: Collection<T>,
  keys: Record<string, 1 | -1>,
  options: CreateIndexesOptions & { name: string },
): Promise<void> {
  try {
    await col.createIndex(keys, options)
  } catch (err) {
    const code = errorCode(err)
    if (code !== INDEX_OPTIONS_CONFLICT && code !== INDEX_KEY_SPECS_CONFLICT) throw err
    try {
      await col.dropIndex(options.name)
    } catch (dropErr) {
      if (errorCode(dropErr) !== INDEX_NOT_FOUND) throw dropErr
      console.warn(`[Indexes] ${col.collectionName}.${options.name}: an equivalent index exists under another name — kept`)
      return
    }
    await col.createIndex(keys, options)
    console.log(`[Indexes] ${col.collectionName}.${options.name}: spec changed — dropped and recreated`)
  }
}

/** Names of the collection's indexes; [] when it doesn't exist (or on fakes). */
async function existingIndexNames<T extends Document>(col: Collection<T>): Promise<Set<string>> {
  try {
    const indexes = await col.listIndexes().toArray()
    return new Set(indexes.map((ix) => ix.name as string))
  } catch {
    return new Set()
  }
}

async function applyDefs<T extends Document>(col: Collection<T>, defs: readonly IndexDef[]): Promise<void> {
  const existing = await existingIndexNames(col)
  for (const def of defs) {
    // A unique build that already failed on duplicates left `<name>_nonunique`
    // behind; retrying would rescan the whole collection on every boot.
    if (existing.has(`${def.name}_nonunique`)) continue
    if (def.heal) {
      try {
        await createIndexHealingConflict(col, def.key, indexOptions(def))
      } catch (err) {
        if (errorCode(err) !== DUPLICATE_KEY || !def.unique) throw err
        await ensureIndexOn(col, def.key, indexOptions(def))
      }
    } else {
      await ensureIndexOn(col, def.key, indexOptions(def))
    }
  }
}

/** Apply the registry entries of one collection through an existing handle. */
export async function ensureCollectionIndexes<T extends Document>(col: Collection<T>, name: CollectionName): Promise<void> {
  await applyDefs(col, INDEXES[name] ?? [])
}

/** Apply the registry entries of the given collections. */
export async function ensureIndexesFor(db: Db, names: readonly CollectionName[]): Promise<void> {
  for (const name of names) await ensureCollectionIndexes(db.collection(name), name)
}

/** Indexes of a dynamic `agent_app_storage_*` collection. */
export async function ensureAgentAppStorageIndexes(db: Db, collectionName: string): Promise<void> {
  await applyDefs(db.collection(collectionName), AGENT_APP_STORAGE_INDEXES)
}

/**
 * Apply the whole registry. Idempotent: an index that already exists with the
 * same name and spec is a no-op. Runs at boot after runMigrations.
 */
export async function ensureAllIndexes(db: Db): Promise<{ collections: number; indexes: number }> {
  let indexes = 0
  const names = Object.keys(INDEXES) as CollectionName[]
  for (const name of names) {
    await ensureCollectionIndexes(db.collection(name), name)
    indexes += INDEXES[name]?.length ?? 0
  }
  return { collections: names.length, indexes }
}

