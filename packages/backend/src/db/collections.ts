/**
 * Every MongoDB collection the backend touches (GOV-1 base).
 *
 * New code takes collection names from here instead of string literals; the
 * ratchet test (tests/unit/db-collections-ratchet.test.ts) fails when a
 * literal names a collection that is not listed, and when the number of raw
 * `.collection(` calls outside src/db grows. Existing calls migrate domain by
 * domain (plan, step 26).
 *
 * Sharding: the shard key will be workspaceId (docs/audit/20261017_plan-data-layer.md
 * §2.1). Collections that hold workspace data must carry workspaceId on every
 * document and prefix their unique indexes with it; query them through
 * `workspaceFilter` (./helpers) so a missing workspaceId fails loudly.
 */
export const COLLECTIONS = {
  migrations: '_migrations',
  agentAppAccess: 'agent_app_access',
  agentAppInstallations: 'agent_app_installations',
  agentAppObjects: 'agent_app_objects',
  /** Legacy (MOD-2): no longer written; kept for its index and the deletion cascade. */
  agentConfigs: 'agent_configs',
  agentCores: 'agent_cores',
  agentProjectRelationships: 'agent_project_relationships',
  agentSkillAccess: 'agent_skill_access',
  agentUsageAccessLog: 'agent_usage_access_log',
  agentUsageEventApplications: 'agent_usage_event_applications',
  agentUsageEvents: 'agent_usage_events',
  agentUsageRollupRuns: 'agent_usage_rollup_runs',
  agentUsageRollupsHourly: 'agent_usage_rollups_hourly',
  agentUsageRollupsUserHourly: 'agent_usage_rollups_user_hourly',
  agentUsageSessions: 'agent_usage_sessions',
  agents: 'agents',
  /** One mailbox per agent (mca.teros.email lifecycle — tn_PcquTN30AawbK8uE). */
  agentMailboxes: 'agent_mailboxes',
  /** Deleted mailbox addresses — never reassigned (no-recycling rule). */
  burnedAddresses: 'burned_addresses',
  apiTokens: 'api_tokens',
  apps: 'apps',
  /** @spec NAV-REQ-2 */
  navbarPins: 'navbar_pins',
  auditLogs: 'audit_logs',
  automateExecutions: 'automate_executions',
  automateStarters: 'automate_starters',
  automateWebhookCalls: 'automate_webhook_calls',
  billingAccessRequests: 'billing_access_requests',
  billingCustomers: 'billing_customers',
  billingHourBoosts: 'billing_hour_boosts',
  billingHourLedger: 'billing_hour_ledger',
  billingInvoices: 'billing_invoices',
  billingPeriodSnapshots: 'billing_period_snapshots',
  billingPlans: 'billing_plans',
  billingSubscriptions: 'billing_subscriptions',
  billingTeams: 'billing_teams',
  billingWebhookEvents: 'billing_webhook_events',
  boardDailyStats: 'board_daily_stats',
  boardEvents: 'board_events',
  boardSubscriptions: 'board_subscriptions',
  boards: 'boards',
  channelMessages: 'channel_messages',
  channelSubscriptions: 'channel_subscriptions',
  channels: 'channels',
  /** Costs API (/api/costs/*) access audit — one row per request (task_6de67c22b163387a). */
  costsAccessLogs: 'costs_access_logs',
  compactions: 'compactions',
  /** Immutable audit trail of user consent changes (profile.set-evaluation-consent). */
  consentAuditLog: 'consent_audit_log',
  /** Conversation Evaluator L2 verdicts (mca-actions/evaluator.ts). */
  conversationEvaluations: 'conversation_evaluations',
  conversationFeedback: 'conversation_feedback',
  conversationUsage: 'conversation_usage',
  deletionLog: 'deletion_log',
  dockerEnvs: 'docker_envs',
  emailAuditLog: 'email_audit_log',
  emailVerifications: 'email_verifications',
  executionSteps: 'execution_steps',
  executions: 'executions',
  featureFlagAuditLog: 'feature_flag_audit_log',
  featureFlagOverrides: 'feature_flag_overrides',
  featureFlags: 'feature_flags',
  feedback: 'feedback',
  flowEventTriggers: 'flow_event_triggers',
  flowWebhookInvocations: 'flow_webhook_invocations',
  flows: 'flows',
  githubWebhookDeliveries: 'github_webhook_deliveries',
  latitudeSignalIndex: 'latitude_signal_index',
  latitudeWebhookDeliveries: 'latitude_webhook_deliveries',
  leaderLocks: 'leader_locks',
  llmUsage: 'llm_usage',
  mcaCatalog: 'mca_catalog',
  mcaData: 'mca_data',
  mcaEventSubscriptions: 'mca_event_subscriptions',
  mcaOauthStates: 'mca_oauth_states',
  mcaSubscriptions: 'mca_subscriptions',
  mcaToolHealth: 'mca_tool_health',
  messageActions: 'message_actions',
  messageFeedback: 'message_feedback',
  messages: 'messages',
  models: 'models',
  oauthStates: 'oauth_states',
  passwordResets: 'password_resets',
  pendingForms: 'pending_forms',
  projects: 'projects',
  rateLimitCounters: 'rate_limit_counters',
  remoteDevices: 'remote_devices',
  remoteDeviceBindings: 'remote_device_bindings',
  schedulerExecutions: 'scheduler_executions',
  schedulerRecurringTasks: 'scheduler_recurring_tasks',
  schedulerReminders: 'scheduler_reminders',
  sessionMessages: 'session_messages',
  sessions: 'sessions',
  sharedFiles: 'shared_files',
  skills: 'skills',
  subscriptionsAgent: 'subscriptions_agent',
  subscriptionsChannel: 'subscriptions_channel',
  subscriptionsCorrelation: 'subscriptions_correlation',
  systemBackfills: 'system_backfills',
  tasks: 'tasks',
  /** Terminal sessions saved to sleep (services/terminal/sleep-store.ts). */
  terminalSleepingSessions: 'terminal_sleeping_sessions',
  /** Teros Guard verdict telemetry, one document per reviewed tool call (services/mca-tool-executor.ts). */
  terosGuardEvaluations: 'teros_guard_evaluations',
  terosProviderConfigs: 'teros_provider_configs',
  /** To Do autoplay runners per (workspace, agent) (services/todo-autoplay-service.ts). */
  todoAutoplayRunners: 'todo_autoplay_runners',
  /** Workspace-level Tasks autoplay global play/pause state (TODOAP-REQ-30). */
  todoAutoplayState: 'todo_autoplay_state',
  todoNodes: 'todo_nodes',
  /** To-do list event subscriptions (TodoSubscriptionService, todo/events spec). */
  todoSubscriptions: 'todo_subscriptions',
  toolExecutions: 'tool_executions',
  transcriptionLogs: 'transcription_logs',
  usageWindows: 'usage_windows',
  userCredentials: 'user_credentials',
  userDesktopState: 'user_desktop_state',
  userEncryptionKeys: 'user_encryption_keys',
  userIdentities: 'user_identities',
  userProviders: 'user_providers',
  userSessions: 'user_sessions',
  users: 'users',
  voiceSessions: 'voice_sessions',
  voiceTelemetrySessions: 'voice_telemetry_sessions',
  volumes: 'volumes',
  workspaceMembers: 'workspace_members',
  workspaces: 'workspaces',
} as const

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS]

const NAMES: ReadonlySet<string> = new Set(Object.values(COLLECTIONS))

export function isKnownCollection(name: string): name is CollectionName {
  return NAMES.has(name)
}
