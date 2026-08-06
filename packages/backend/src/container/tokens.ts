/**
 * Dependency Injection Tokens
 *
 * Type-safe tokens for all injectable dependencies in Teros backend.
 * Using symbols ensures uniqueness and prevents accidental collisions.
 *
 * @example
 * ```typescript
 * // Registration
 * container.register(Tokens.McaService, (c) => new McaService(c.get(Tokens.Db)));
 *
 * // Resolution (type-safe!)
 * const mcaService = container.get(Tokens.McaService); // type: IMcaService
 * ```
 */

import type { Clock, IdGenerator, SessionLockManager } from '@teros/core';
import type { Db } from 'mongodb';
import type { AgentUsageEventApplier } from '../services/agent-usage-event-applier';
import type { LatitudeExportMetrics } from '../services/latitude-export-metrics';
import type { LatitudeReadClient } from '../services/latitude-read-client';
import type { LatitudeScoreEmitter } from '../services/latitude-score-emitter';
import type { LatitudeScoreMetricsRecorder } from '../services/latitude-score-metrics';
import type { LatitudeSignalIndex } from '../services/latitude-signal-index';
import type { SessionTraceExporter } from '../services/session-trace-export-service';
import type { AgentUsageEventApplicationsRepository } from '../services/agent-usage-event-applications-repository';
import type { AgentUsageEventRepository } from '../services/agent-usage-event-repository';
import type { AgentUsageReconciler } from '../services/agent-usage-reconciler';
import type { AgentHoursTracker } from '../services/agent-hours-tracker';
import type { AgentUsageRollupJob } from '../services/agent-usage-rollup-job';
import type { AgentUsageSessionRepository } from '../services/agent-usage-session-repository';
import type { BillingResetCron } from '../services/billing-reset-cron';
import type { BillingReconciliationCron } from '../services/billing-reconciliation-cron';
import type { StripePaymentService } from '../services/stripe-payment-service';
import type { BillingChargeCron } from '../services/billing-charge-cron';
import type { AgentUsageSessionService } from '../services/agent-usage-session-service';
import type { LeaderElectionService } from '../services/leader-election';
import type { ToolExecutionRepository } from '../services/tool-execution-repository';
import type { ToolExecutionService } from '../services/tool-execution-service';
import type { UsageEventBuffer } from '../services/usage-event-buffer';
import type { AuthManager } from '../auth/auth-manager';
import type { AuthService } from '../auth/auth-service';
import type { DefaultAgentService } from '../auth/default-agent-service';
import type { IdentityService } from '../auth/identity-service';
import type { SessionService } from '../auth/session-service';
import type { UserService } from '../auth/user-service';
import type { EventHandler } from '../handlers/event-handler';
import type { MessageHandler } from '../handlers/message-handler';
import type { WebSocketHandler } from '../handlers/websocket-handler';
import type { SecretsManager } from '../secrets/secrets-manager';
import type { AutoplayService } from '../services/autoplay-service';
import type { BoardSubscriptionService } from '../services/board-subscription-service';
import type { BoardService } from '../services/board-service';
import type { ChannelManager } from '../services/channel-manager';
import type { FeatureFlagService } from '../services/feature-flag-service';
import type { DesktopStateService } from '../services/desktop-state-service';
import type { McaManager } from '../services/mca-manager';
import type { McaService } from '../services/mca-service';
import type { MCAEventSubscriptionService } from '../services/mca-event-subscription-service';
import type { ModelService } from '../services/model-service';
import type { ProjectService } from '../services/project-service';
import type { ProviderService } from '../services/provider-service';
import type { PubSubService } from '../services/pubsub-service';
import type { PtyManager } from '../services/pty-manager';
import type { ResumeService } from '../services/resume-service';
import type { SchedulerService } from '../services/scheduler-service';
// Import service types
// Note: Interfaces exist in ./services/interfaces/ for testing with mocks
import type { SessionManager } from '../services/session-manager';
import type { ShareService } from '../services/share-service';
import type { SkillService } from '../services/skill-service';
import type { UsageService } from '../services/usage-service';
import type { UsageTrackingService } from '../services/usage-tracking-service';
import type { VolumeService } from '../services/volume-service';
import type { WorkspaceService } from '../services/workspace-service';
import type { MongoSessionStore } from '../session/MongoSessionStore';
import { createToken, type Token } from './types';

/**
 * All dependency injection tokens
 *
 * Organized by category:
 * - Infrastructure: Database, config, secrets
 * - Services: Business logic services
 * - Handlers: Request/event handlers
 * - Core: Shared core components
 */
export const Tokens = {
  // ============================================================================
  // INFRASTRUCTURE
  // ============================================================================

  /** MongoDB database instance */
  Db: createToken<Db>('Db'),

  /** Secrets manager for credentials */
  SecretsManager: createToken<SecretsManager>('SecretsManager'),

  /** Application configuration */
  Config: createToken<AppConfig>('Config'),

  /** Clock — fuente de tiempo inyectable (determinista en modo test). TER-563. */
  Clock: createToken<Clock>('Clock'),

  /** IdGenerator — fuente de IDs inyectable (determinista en modo test). TER-563. */
  IdGenerator: createToken<IdGenerator>('IdGenerator'),

  // ============================================================================
  // AUTH
  // ============================================================================

  /** Authentication manager */
  AuthManager: createToken<AuthManager>('AuthManager'),

  /** Auth service (login, register, session validation) */
  AuthService: createToken<AuthService>('AuthService'),

  /** User service (CRUD on user profiles) */
  UserService: createToken<UserService>('UserService'),

  /** Identity service (OAuth identities) */
  IdentityService: createToken<IdentityService>('IdentityService'),

  /** Session service (auth session records) */
  SessionService: createToken<SessionService>('SessionService'),

  /** Default agent service (per-user default agent provisioning) */
  DefaultAgentService: createToken<DefaultAgentService>('DefaultAgentService'),

  // ============================================================================
  // SERVICES
  // ============================================================================

  /** WebSocket session manager */
  SessionManager: createToken<SessionManager>('SessionManager'),

  /** Unified pub/sub service */
  PubSubService: createToken<PubSubService>('PubSubService'),

  /** MCA event subscription service (high-level topic routing) */
  MCAEventSubscriptionService: createToken<MCAEventSubscriptionService>('MCAEventSubscriptionService'),

  /** Channel/conversation manager */
  ChannelManager: createToken<ChannelManager>('ChannelManager'),

  /** MCA (Model Context App) lifecycle manager */
  McaManager: createToken<McaManager>('McaManager'),

  /** MCA service for app/catalog operations */
  McaService: createToken<McaService>('McaService'),

  /** Volume service for container storage */
  VolumeService: createToken<VolumeService>('VolumeService'),

  /** Workspace service for project/collaboration contexts */
  WorkspaceService: createToken<WorkspaceService>('WorkspaceService'),

  /** Board service for projects, boards, and tasks */
  BoardService: createToken<BoardService>('BoardService'),

  /** Token usage tracking service */
  UsageService: createToken<UsageService>('UsageService'),

  /** LLM model configuration service */
  ModelService: createToken<ModelService>('ModelService'),

  /** LLM provider management service */
  ProviderService: createToken<ProviderService>('ProviderService'),

  /** Scheduled tasks service */
  SchedulerService: createToken<SchedulerService>('SchedulerService'),

  /** Session resume service */
  ResumeService: createToken<ResumeService>('ResumeService'),

  /** Skill service (workspace skills / agent system prompt blocks) */
  SkillService: createToken<SkillService>('SkillService'),

  /** Project service (workspace projects) */
  ProjectService: createToken<ProjectService>('ProjectService'),

  /** Share service (public file share links) */
  ShareService: createToken<ShareService>('ShareService'),

  /** Usage tracking service (LLM cost analytics) */
  UsageTrackingService: createToken<UsageTrackingService>('UsageTrackingService'),

  /** Desktop state service (per-user UI layout persistence) */
  DesktopStateService: createToken<DesktopStateService>('DesktopStateService'),

  /** Board subscription service (real-time board event routing) */
  BoardSubscriptionService: createToken<BoardSubscriptionService>('BoardSubscriptionService'),

  /** Feature flag service (hierarchical flag resolution and overrides) */
  FeatureFlagService: createToken<FeatureFlagService>('FeatureFlagService'),

  /** Autoplay service (board task auto-scheduling) */
  AutoplayService: createToken<AutoplayService>('AutoplayService'),

  /** PTY manager (terminal session management) */
  PtyManager: createToken<PtyManager>('PtyManager'),

  // ============================================================================
  // SESSION/STORAGE
  // ============================================================================

  /** MongoDB session store */
  SessionStore: createToken<MongoSessionStore>('SessionStore'),

  /** Session lock manager */
  LockManager: createToken<SessionLockManager>('LockManager'),

  // ============================================================================
  // HANDLERS
  // ============================================================================

  /** Event handler for scheduled events */
  EventHandler: createToken<EventHandler>('EventHandler'),

  /** WebSocket connection handler */
  WebSocketHandler: createToken<WebSocketHandler>('WebSocketHandler'),

  /** Message processing handler */
  MessageHandler: createToken<MessageHandler>('MessageHandler'),

  // ============================================================================
  // AGENT USAGE INSTRUMENTATION
  // ============================================================================

  /** Repository for agent_usage_events (append-only event store). */
  AgentUsageEventRepository: createToken<AgentUsageEventRepository>('AgentUsageEventRepository'),

  /** Repository for agent_usage_event_applications (idempotency log). */
  AgentUsageEventApplicationsRepository: createToken<AgentUsageEventApplicationsRepository>(
    'AgentUsageEventApplicationsRepository',
  ),

  /** Repository for agent_usage_sessions (one doc per turn). */
  AgentUsageSessionRepository: createToken<AgentUsageSessionRepository>(
    'AgentUsageSessionRepository',
  ),

  /** Repository for tool_executions. */
  ToolExecutionRepository: createToken<ToolExecutionRepository>('ToolExecutionRepository'),

  /** Worker that applies AgentUsageEvent to projections. */
  AgentUsageEventApplier: createToken<AgentUsageEventApplier>('AgentUsageEventApplier'),

  /** F3a — Latitude OTLP export. Null when LATITUDE_EXPORT_* is not configured. */
  SessionTraceExporter: createToken<SessionTraceExporter | null>('SessionTraceExporter'),
  /** F3a — export health counters (always present; zeros when the export is off). */
  LatitudeExportMetrics: createToken<LatitudeExportMetrics>('LatitudeExportMetrics'),

  /** F4·C0 — Latitude score emitter. Null when LATITUDE_API_URL / TOKEN / PROJECT is not configured. */
  LatitudeScoreEmitter: createToken<LatitudeScoreEmitter | null>('LatitudeScoreEmitter'),
  /** F4·C0 — score emitter health counters (always present; zeros when the emitter is off). */
  LatitudeScoreMetrics: createToken<LatitudeScoreMetricsRecorder>('LatitudeScoreMetrics'),

  /** F4·C1 — traceId→signal projection fed by the Latitude webhook (badge). */
  LatitudeSignalIndex: createToken<LatitudeSignalIndex>('LatitudeSignalIndex'),

  /** F4·C2 — Latitude signals read client (dashboard). Null when LATITUDE_API_URL / TOKEN / PROJECT is not configured. */
  LatitudeReadClient: createToken<LatitudeReadClient | null>('LatitudeReadClient'),

  /** In-memory event buffer (fire-and-forget, dead-letter on failure). */
  UsageEventBuffer: createToken<UsageEventBuffer>('UsageEventBuffer'),

  /** Domain service for agent usage sessions. */
  AgentUsageSessionService: createToken<AgentUsageSessionService>('AgentUsageSessionService'),

  /** Domain service for tool executions. */
  ToolExecutionService: createToken<ToolExecutionService>('ToolExecutionService'),

  /** Reconciler that closes orphan sessions / tool executions. */
  AgentUsageReconciler: createToken<AgentUsageReconciler>('AgentUsageReconciler'),

  /** Hourly rollup job (per-agent + per-user). */
  AgentUsageRollupJob: createToken<AgentUsageRollupJob>('AgentUsageRollupJob'),

  /** Agent hours tracker — reads rollups and accumulates into billing_subscriptions. */
  AgentHoursTracker: createToken<AgentHoursTracker>('AgentHoursTracker'),

  /** Billing reset cron — resets agentHoursUsed when currentPeriodEnd passes. */
  BillingResetCron: createToken<BillingResetCron>('BillingResetCron'),

  /** Billing reconciliation cron — daily drift/lag/duplicate audit of billing. */
  BillingReconciliationCron: createToken<BillingReconciliationCron>('BillingReconciliationCron'),

  /** Stripe payment service — customer mapping, vaulting, invoice charging (FASE 4). */
  StripePaymentService: createToken<StripePaymentService>('StripePaymentService'),

  /** Billing charge cron — charges pending invoices via Stripe + dunning (FASE 4). */
  BillingChargeCron: createToken<BillingChargeCron>('BillingChargeCron'),

  /**
   * Distributed leader election (multi-instance safety).
   *
   * Backed by the `leader_locks` collection. The reconciler, rollup job and
   * Sentry alarm bridge each acquire a named lock before running their tick,
   * so background work runs on exactly one instance at any time. The lock
   * has a TTL — if the leader crashes, another instance takes over within
   * one tick.
   */
  LeaderElectionService: createToken<LeaderElectionService>('LeaderElectionService'),
} as const;

/**
 * Application configuration interface
 */
export interface AppConfig {
  mongodb: {
    uri: string;
    dbName: string;
  };
  server: {
    port: number;
    host: string;
  };
  admin: {
    apiKey?: string;
  };
  mca: {
    mcasPath: string;
    secretsPath: string;
    idleTimeoutMs: number;
    cleanupIntervalMs: number;
  };
  volumes: {
    basePath: string;
    defaultWorkspaceQuota: number;
  };
}

/**
 * Type helper to extract the type from a token
 *
 * @example
 * ```typescript
 * type McaServiceType = TokenType<typeof Tokens.McaService>; // IMcaService
 * ```
 */
export type TokenType<T> = T extends Token<infer U> ? U : never;
