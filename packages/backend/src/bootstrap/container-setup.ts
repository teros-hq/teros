/**
 * Container Setup
 *
 * Registers all service dependencies in the DI container.
 * Extracted from index.ts for maintainability.
 */

import { resolve } from 'path'
import type { Db } from 'mongodb'
import { FixedClock, RandomIdGenerator, SeededIdGenerator, SystemClock } from '@teros/core'
import { type Container, Tokens } from '../container'
import { config } from '../config'
import type { AuthManager } from '../auth/auth-manager'
import type { McaOAuth } from '../auth/mca-oauth'
import type { SecretsManager } from '../secrets/secrets-manager'

import { AutoplayService } from '../services/autoplay-service'
import { BoardService } from '../services/board-service'
import { BoardSubscriptionService } from '../services/board-subscription-service'
import { ChannelManager } from '../services/channel-manager'
import { DesktopStateService } from '../services/desktop-state-service'
import { FeatureFlagService } from '../services/feature-flag-service'
import { McaManager } from '../services/mca-manager'
import { McaService } from '../services/mca-service'
import { MCAEventSubscriptionService } from '../services/mca-event-subscription-service'
import { ModelService } from '../services/model-service'
import { ProjectService } from '../services/project-service'
import { ProviderService } from '../services/provider-service'
import { PtyManager } from '../services/pty-manager'
import { PubSubService } from '../services/pubsub-service'
import { ResumeService } from '../services/resume-service'
import { SchedulerService } from '../services/scheduler-service'
import { SessionManager } from '../services/session-manager'
import { ShareService } from '../services/share-service'
import { SkillService } from '../services/skill-service'
import { UsageService } from '../services/usage-service'
import { UsageTrackingService } from '../services/usage-tracking-service'
import { AgentUsageEventApplicationsRepository } from '../services/agent-usage-event-applications-repository'
import { AgentUsageEventApplier } from '../services/agent-usage-event-applier'
import { createCachedGlobalFlag } from '../services/cached-global-flag'
import { LatitudeExportMetrics } from '../services/latitude-export-metrics'
import { createLatitudeReadClient } from '../services/latitude-read-client'
import { LatitudeScoreEmitter, createLatitudeScoreClient } from '../services/latitude-score-emitter'
import { LatitudeScoreMetricsRecorder } from '../services/latitude-score-metrics'
import { LatitudeSignalIndex } from '../services/latitude-signal-index'
import { createLatitudeExporter } from '../services/otel-latitude-exporter'
import { SessionTraceExporter } from '../services/session-trace-export-service'
import { AgentUsageEventRepository } from '../services/agent-usage-event-repository'
import { AgentHoursTracker, DEFAULT_TRACKER_OPTS } from '../services/agent-hours-tracker'
import { AgentUsageReconciler, DEFAULT_RECONCILER_OPTS } from '../services/agent-usage-reconciler'
import { AgentUsageRollupJob } from '../services/agent-usage-rollup-job'
import { BillingResetCron } from '../services/billing-reset-cron'
import { BillingReconciliationCron } from '../services/billing-reconciliation-cron'
import { StripePaymentService } from '../services/stripe-payment-service'
import { createStripeClient } from '../services/stripe-client'
import { BillingChargeCron } from '../services/billing-charge-cron'
import { AgentUsageSessionRepository } from '../services/agent-usage-session-repository'
import { AgentUsageSessionService } from '../services/agent-usage-session-service'
import { LeaderElectionService } from '../services/leader-election'
import { ToolExecutionRepository } from '../services/tool-execution-repository'
import { ToolExecutionService } from '../services/tool-execution-service'
import { UsageEventBuffer } from '../services/usage-event-buffer'
import { INSTANCE_ID } from '../lib/instance-id'
import { createLogger } from '../lib/logger'
import { VolumeService } from '../services/volume-service'
import { WorkspaceService } from '../services/workspace-service'
import { AuthService } from '../auth/auth-service'
import { DefaultAgentService } from '../auth/default-agent-service'
import { IdentityService } from '../auth/identity-service'
import { SessionService } from '../auth/session-service'
import { UserService } from '../auth/user-service'
import { EventHandler } from '../handlers/event-handler'
import { MongoSessionStore } from '../session/MongoSessionStore'

/**
 * Grace period (minutes) added to the turn deadline before the reconciler
 * treats a still-open session as an orphan. Covers the reconciler's own tick
 * interval + clock skew so a turn that finishes right at the deadline is never
 * closed to $0 (TER-650/G1).
 */
const RECONCILER_STALE_BUFFER_MIN = 5

/**
 * Register all dependencies in the container
 */
export function registerDependencies(
  container: Container,
  db: Db,
  secretsManager: SecretsManager,
  authManager: AuthManager,
  mcaOAuth: McaOAuth,
): void {
  // Infrastructure
  container.registerInstance(Tokens.Db, db)
  container.registerInstance(Tokens.SecretsManager, secretsManager)
  container.registerInstance(Tokens.AuthManager, authManager)

  // Clock + IdGenerator inyectables. En modo determinista (TEROS_DETERMINISTIC, solo en el
  // compose e2e/record) se congelan para que el [Current Context] y los channelId sean estables
  // → el replay del LLM hace match por hash. En prod: reloj real + IDs aleatorios. TER-563.
  {
    const deterministic = process.env.TEROS_DETERMINISTIC === '1'
    const seed = process.env.TEROS_TEST_SEED ?? 'teros-e2e'
    const epochMs = Number(process.env.TEROS_TEST_EPOCH_MS ?? '1700000000000')
    container.registerInstance(Tokens.Clock, deterministic ? new FixedClock(epochMs) : new SystemClock())
    container.registerInstance(
      Tokens.IdGenerator,
      deterministic ? new SeededIdGenerator(seed) : new RandomIdGenerator(),
    )
  }

  // Session management
  container.register(Tokens.SessionManager, () => new SessionManager())
  container.register(Tokens.SessionStore, (c) => new MongoSessionStore(c.get(Tokens.Db)))

  // Business services
  container.register(Tokens.ProviderService, (c) => new ProviderService(c.get(Tokens.Db)))
  container.register(
    Tokens.ChannelManager,
    (c) => new ChannelManager(c.get(Tokens.Db), c.get(Tokens.ProviderService), c.get(Tokens.IdGenerator)),
  )
  container.register(Tokens.UsageService, (c) => new UsageService(c.get(Tokens.Db)))
  container.register(Tokens.ModelService, (c) => new ModelService(c.get(Tokens.Db)))

  // Volume Service
  container.register(
    Tokens.VolumeService,
    (c) =>
      new VolumeService(c.get(Tokens.Db), {
        basePath: config.volumes.basePath,
        defaultWorkspaceQuota: config.volumes.defaultWorkspaceQuota,
      }),
  )

  // Workspace Service (must be before McaService)
  container.register(
    Tokens.WorkspaceService,
    (c) => new WorkspaceService(c.get(Tokens.Db), c.get(Tokens.VolumeService)),
  )

  // Board Service (needs to be before WebSocketHandler)
  // IdGenerator: el board runner inyecta el taskId en el prompt del agente → sembrarlo hace
  // determinista el replay LLM de las tareas de board en modo test (TER-563).
  container.register(
    Tokens.BoardService,
    (c) => new BoardService(c.get(Tokens.Db), c.get(Tokens.IdGenerator)),
  )

  // Auth services
  container.register(Tokens.UserService, (c) => new UserService(c.get(Tokens.Db)))
  container.register(Tokens.IdentityService, (c) => new IdentityService(c.get(Tokens.Db)))
  container.register(Tokens.SessionService, (c) => new SessionService(c.get(Tokens.Db)))
  container.register(Tokens.DefaultAgentService, (c) => new DefaultAgentService(c.get(Tokens.Db)))
  container.register(Tokens.AuthService, (c) => new AuthService(c.get(Tokens.Db)))

  // Business services (leaf — no cross-service deps)
  container.register(Tokens.SkillService, (c) => new SkillService(c.get(Tokens.Db)))
  container.register(Tokens.ProjectService, (c) => new ProjectService(c.get(Tokens.Db)))
  container.register(Tokens.ShareService, (c) => new ShareService(c.get(Tokens.Db)))
  container.register(Tokens.DesktopStateService, (c) => new DesktopStateService(c.get(Tokens.Db)))
  container.register(Tokens.UsageTrackingService, (c) => new UsageTrackingService(c.get(Tokens.Db)))
  container.register(Tokens.BoardSubscriptionService, (c) => new BoardSubscriptionService(c.get(Tokens.Db)))
  container.register(Tokens.FeatureFlagService, (c) => new FeatureFlagService(c.get(Tokens.Db)))

  // PubSub + dependents
  container.register(Tokens.PubSubService, (c) => new PubSubService(c.get(Tokens.Db)))
  container.register(Tokens.MCAEventSubscriptionService, (c) => new MCAEventSubscriptionService(c.get(Tokens.Db)))
  container.register(Tokens.PtyManager, (c) => new PtyManager(c.get(Tokens.PubSubService)))
  container.register(
    Tokens.AutoplayService,
    (c) => new AutoplayService(c.get(Tokens.Db), c.get(Tokens.PubSubService), c.get(Tokens.ChannelManager), config.autoplay.autoWakeCap),
  )

  // MCA Service (needs WorkspaceService and VolumeService for app installation)
  container.register(
    Tokens.McaService,
    (c) =>
      new McaService(c.get(Tokens.Db), {
        secretsManager: c.get(Tokens.SecretsManager),
        authManager: c.get(Tokens.AuthManager),
        workspaceService: c.get(Tokens.WorkspaceService),
        volumeService: c.get(Tokens.VolumeService),
      }),
  )

  // MCA Manager (optional, depends on config)
  if (config.mca.basePath) {
    const mcaBasePath = resolve(config.mca.basePath)
    container.register(
      Tokens.McaManager,
      (c) =>
        new McaManager(c.get(Tokens.Db), {
          mcaBasePath,
          secretsManager: c.get(Tokens.SecretsManager),
          authManager: c.get(Tokens.AuthManager),
          volumeService: c.get(Tokens.VolumeService),
          maxIdleMs: 30 * 60 * 1000,
          maxRestarts: 3,
          cleanupIntervalMs: 5 * 60 * 1000,
          serverPort: config.server.port,
        }),
    )
  }

  // Event handler
  container.register(
    Tokens.EventHandler,
    (c) =>
      new EventHandler(
        c.get(Tokens.Db),
        c.get(Tokens.SessionManager),
        c.get(Tokens.ChannelManager),
      ),
  )

  // Scheduler service — receives MCAEventSubscriptionService for unified event dispatch
  // mcaEventSubscriptionService is created later in the bootstrap, so we pass it lazily
  // via a setter pattern. The container registration uses a factory that captures the ref.
  container.register(
    Tokens.SchedulerService,
    (c) => new SchedulerService(c.get(Tokens.Db), c.get(Tokens.EventHandler)),
  )

  // Resume service
  container.register(
    Tokens.ResumeService,
    (c) =>
      new ResumeService(c.get(Tokens.Db), c.get(Tokens.EventHandler), c.get(Tokens.ChannelManager)),
  )

  // ===========================================================================
  // AGENT USAGE INSTRUMENTATION
  // ===========================================================================
  // Event sourcing pipeline:
  //   handlers / tool executor → SessionService / ToolExecutionService
  //     → UsageEventBuffer.emit() → flush bulkInsert → EventApplier.applyBatch
  //       → AgentUsageSessionRepository / ToolExecutionRepository (projections)
  // Background jobs: reconciler + rollup job (started in server-bootstrap.ts).
  //
  // Feature flags (decision #15):
  //   AGENT_USAGE_INSTRUMENTATION_ENABLED — cuts off emission in handlers/tools
  //   AGENT_USAGE_BACKGROUND_JOBS_ENABLED — cuts off reconciler / rollup ticks
  // ===========================================================================
  container.register(
    Tokens.AgentUsageEventRepository,
    (c) => new AgentUsageEventRepository(c.get(Tokens.Db)),
  )
  container.register(
    Tokens.AgentUsageEventApplicationsRepository,
    (c) => new AgentUsageEventApplicationsRepository(c.get(Tokens.Db)),
  )
  container.register(
    Tokens.AgentUsageSessionRepository,
    (c) => new AgentUsageSessionRepository(c.get(Tokens.Db)),
  )
  container.register(
    Tokens.ToolExecutionRepository,
    (c) => new ToolExecutionRepository(c.get(Tokens.Db)),
  )
  // F3a — export health counters (always present; zeros when export is off).
  container.register(Tokens.LatitudeExportMetrics, () => new LatitudeExportMetrics())
  // F3a — Latitude OTLP export. Null (disabled) unless LATITUDE_EXPORT_* is set;
  // the flag `observability.latitude-export` is the runtime toggle on top of that.
  container.register(Tokens.SessionTraceExporter, (c) => {
    const url = process.env.LATITUDE_EXPORT_URL
    const token = process.env.LATITUDE_EXPORT_TOKEN
    const project = process.env.LATITUDE_EXPORT_PROJECT
    if (!url || !token || !project) return null
    const log = createLogger('SessionTraceExporter')
    const metrics: LatitudeExportMetrics = c.get(Tokens.LatitudeExportMetrics)
    const transport = createLatitudeExporter({
      url,
      token,
      project,
      hooks: {
        onEnqueue: (n) => metrics.recordEnqueued(n),
        onExportResult: (ok, n) => metrics.recordExportResult(ok, n),
      },
    })
    const flag = createCachedGlobalFlag(
      c.get(Tokens.FeatureFlagService),
      'observability.latitude-export',
      { onError: (err) => log.warn({ err }, 'latitude-export flag resolve failed') },
    )
    return new SessionTraceExporter({
      db: c.get(Tokens.Db),
      transport,
      isEnabled: () => flag.get(),
      log,
      metrics,
    })
  })
  // F4·C0 — score emitter health counters (always present; zeros when off).
  container.register(Tokens.LatitudeScoreMetrics, () => new LatitudeScoreMetricsRecorder())
  // F4·C0 — Latitude score emitter. Null (disabled) unless the scores API config
  // is set. Reuses F3a's TOKEN/PROJECT but needs its own LATITUDE_API_URL: scores
  // hit the REST API, NOT the OTLP ingest (LATITUDE_EXPORT_URL). The flag
  // `observability.latitude-scores` is the runtime toggle on top of that.
  container.register(Tokens.LatitudeScoreEmitter, (c) => {
    const apiUrl = process.env.LATITUDE_API_URL
    const token = process.env.LATITUDE_EXPORT_TOKEN
    const project = process.env.LATITUDE_EXPORT_PROJECT
    if (!apiUrl || !token || !project) return null
    const log = createLogger('LatitudeScoreEmitter')
    const client = createLatitudeScoreClient({ apiBaseUrl: apiUrl, token, project })
    const flag = createCachedGlobalFlag(
      c.get(Tokens.FeatureFlagService),
      'observability.latitude-scores',
      { onError: (err) => log.warn({ err }, 'latitude-scores flag resolve failed') },
    )
    return new LatitudeScoreEmitter({
      db: c.get(Tokens.Db),
      client,
      isEnabled: () => flag.get(),
      log,
      metrics: c.get(Tokens.LatitudeScoreMetrics),
    })
  })
  // F4·C1 — traceId→signal projection (fed by the Latitude webhook, read by the
  // Session Trace badge). Always registered; empty until the webhook populates it.
  container.register(Tokens.LatitudeSignalIndex, (c) => new LatitudeSignalIndex(c.get(Tokens.Db)))
  // F4·C2 — signals dashboard read client. Null (disabled → dashboard shows
  // "unconfigured") unless the scores API config is set. Reuses C0's API URL +
  // TOKEN/PROJECT; LATITUDE_BASE_URL (the web host) is optional and only powers
  // the deep links. Read-only + inbound, so there is no runtime flag to gate it.
  container.register(Tokens.LatitudeReadClient, () => {
    const apiUrl = process.env.LATITUDE_API_URL
    const token = process.env.LATITUDE_EXPORT_TOKEN
    const project = process.env.LATITUDE_EXPORT_PROJECT
    if (!apiUrl || !token || !project) return null
    return createLatitudeReadClient({
      apiBaseUrl: apiUrl,
      webBaseUrl: process.env.LATITUDE_BASE_URL,
      token,
      project,
    })
  })
  container.register(
    Tokens.AgentUsageEventApplier,
    (c) =>
      new AgentUsageEventApplier(
        c.get(Tokens.AgentUsageEventApplicationsRepository),
        c.get(Tokens.AgentUsageSessionRepository),
        c.get(Tokens.ToolExecutionRepository),
        createLogger('AgentUsageEventApplier'),
        c.get(Tokens.SessionTraceExporter) ?? undefined,
        c.get(Tokens.LatitudeScoreEmitter) ?? undefined,
      ),
  )
  container.register(
    Tokens.UsageEventBuffer,
    (c) =>
      new UsageEventBuffer(
        c.get(Tokens.AgentUsageEventRepository),
        c.get(Tokens.AgentUsageEventApplier),
        createLogger('UsageEventBuffer'),
      ),
  )
  container.register(
    Tokens.AgentUsageSessionService,
    (c) => new AgentUsageSessionService(c.get(Tokens.UsageEventBuffer)),
  )
  container.register(
    Tokens.ToolExecutionService,
    (c) => new ToolExecutionService(c.get(Tokens.UsageEventBuffer)),
  )
  container.register(
    Tokens.LeaderElectionService,
    (c) => new LeaderElectionService(c.get(Tokens.Db), INSTANCE_ID),
  )
  container.register(
    Tokens.AgentUsageReconciler,
    (c) =>
      new AgentUsageReconciler(
        c.get(Tokens.AgentUsageSessionRepository),
        c.get(Tokens.ToolExecutionRepository),
        createLogger('AgentUsageReconciler'),
        c.get(Tokens.LeaderElectionService),
        // Derive the stale threshold from the absolute turn deadline instead of
        // a hardcoded 15 min. A `running` session cannot legitimately outlive
        // the deadline (the core aborts it), so deadline + buffer is the exact
        // point past which a still-open turn is a real orphan. Keying off the
        // deadline (not the batching window) is what lets execution-anchored
        // sessions survive a legit 15–30 min turn without being closed to $0
        // (TER-650/G1). Same threshold gates queue-orphans by createdAt.
        {
          ...DEFAULT_RECONCILER_OPTS,
          staleThresholdMin:
            Math.ceil(config.turnTimeouts.turnDeadlineMs / 60_000) +
            RECONCILER_STALE_BUFFER_MIN,
        },
      ),
  )
  container.register(
    Tokens.AgentUsageRollupJob,
    (c) =>
      new AgentUsageRollupJob(
        c.get(Tokens.Db),
        createLogger('AgentUsageRollupJob'),
        c.get(Tokens.LeaderElectionService),
      ),
  )
  container.register(
    Tokens.AgentHoursTracker,
    (c) =>
      new AgentHoursTracker(
        c.get(Tokens.Db),
        createLogger('AgentHoursTracker'),
        c.get(Tokens.LeaderElectionService),
        DEFAULT_TRACKER_OPTS,
        // PubSub for the 80%-usage warning (decision #11). The tracker emits
        // billing.usage-warning to the user's live sessions.
        c.get(Tokens.PubSubService),
      ),
  )
  container.register(
    Tokens.BillingResetCron,
    (c) =>
      new BillingResetCron(
        c.get(Tokens.Db),
        createLogger('BillingResetCron'),
        c.get(Tokens.LeaderElectionService),
      ),
  )
  container.register(
    Tokens.BillingReconciliationCron,
    (c) =>
      new BillingReconciliationCron(
        c.get(Tokens.Db),
        createLogger('BillingReconciliationCron'),
        c.get(Tokens.LeaderElectionService),
        c.get(Tokens.StripePaymentService),
      ),
  )
  // Stripe payment rail (FASE 4). createStripeClient returns null when the
  // `stripe` system secret is absent → the service is disabled and billing
  // stays manual; no Stripe SDK calls are made.
  container.register(Tokens.StripePaymentService, (c) => {
    const stripeSecret = c.get<SecretsManager>(Tokens.SecretsManager).system('stripe')
    return new StripePaymentService(
      c.get(Tokens.Db),
      createStripeClient(stripeSecret),
      stripeSecret?.publishableKey ?? null,
    )
  })
  container.register(
    Tokens.BillingChargeCron,
    (c) =>
      new BillingChargeCron(
        c.get(Tokens.Db),
        createLogger('BillingChargeCron'),
        c.get(Tokens.StripePaymentService),
        c.get(Tokens.LeaderElectionService),
      ),
  )
}
