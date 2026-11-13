/**
 * Server Bootstrap
 *
 * Full server initialisation logic extracted from index.ts main().
 * Call bootstrapServer() from index.ts after secrets/DB are ready.
 */

import { createServer } from 'http'
import { NavbarPinsService } from '../services/navbar-pins-service'
import { resolve } from 'path'
import type { Db, MongoClient } from 'mongodb'
import { WebSocketServer } from 'ws'
import { config } from '../config'

/** Read an optional env var (same semantics as config.ts's helper). */
function optionalEnv(name: string): string | undefined {
  const v = process.env[name]
  return v === undefined || v === '' ? undefined : v
}

import { type Container, Tokens } from '../container'
import { initAuthService } from '../auth/auth-service'
import { getDevAutologin, initDevAutologin } from '../auth/dev-autologin'
import { AgentProvisioningService } from '../services/agent-provisioning-service'
import { maybeAutoSeedDevUser } from '../services/dev-seed'
import { auditLogger } from '../lib/audit-logger'
import { initGoogleAuth } from '../auth/google-auth'
import { initGitHubAuth } from '../auth/github-auth'
import { initMicrosoftAuth } from '../auth/microsoft-auth'
import { enableSocialSignIn } from '../auth/sign-in-methods'
import type { McaOAuth } from '../auth/mca-oauth'
import type { AuthManager } from '../auth/auth-manager'
import type { SecretsManager } from '../secrets/secrets-manager'
import { EventHandler } from '../handlers/event-handler'
import { GitHubAppService } from '../auth/github-app'
import { GitHubWebhookHandler } from '../handlers/github-webhook-handler'
import { LatitudeWebhookHandler } from '../handlers/latitude-webhook-handler'
import { AppWebhookHandler } from '../handlers/app-webhook-handler'
import { StripeWebhookHandler } from '../handlers/stripe-webhook-handler'
import { createLogger } from '../lib/logger'
import { extractClientIp } from '../lib/http-security'
import { RateLimiter } from '../services/rate-limiter'
import { HttpAuthHandler } from '../handlers/http-auth-handler'
import { HttpFileHandler } from '../handlers/http-file-handler'
import { HttpMcaAuthHandler } from '../handlers/http-mca-auth-handler'
import { HttpMediaHandler } from '../handlers/http-media-handler'
import { HttpUploadHandler } from '../handlers/http-upload-handler'
import { HttpShareHandler } from '../handlers/http-share-handler'
import { VoiceHandler } from '../handlers/voice-handler'
import { VoiceLoop } from '../handlers/voice-loop'
import { WebSocketHandler } from '../handlers/websocket-handler'
import { FeedbackService } from '../services/feedback-service'
import { TerosGuardService } from '../services/teros-guard-service'
import { createCachedGlobalFlag } from '../services/cached-global-flag'
import { createAdminRoutes } from '../routes/admin-routes'
import { createBoardRoutes } from '../routes/board-routes'
import { createCostsRoutes } from '../routes/costs-routes'
import {
  costsAccessLogger,
  resolveCostsApiKeyFrom,
  resolveCostsEnv,
} from '../services/costs-auth'
import { createAutomateRoutes } from '../routes/automate-routes'
import { AutomateModel } from '../models/automate'
import { AutomateRunner } from '../services/automate-runner'
import type { Message } from '@teros/shared'
import { AUTOMATE_QUOTA_REASON, AutomateQuotaService } from '../services/automate-quota'
import { createMcaCallbackRoutes } from '../routes/mca-callback-routes'
import { AwaitingAuthRegistry } from '../handlers/message/awaiting-auth-registry'
import { setMcaActionDeps } from '../mca-actions'
import { createProviderOAuthRoutes } from '../routes/provider-oauth-routes'
import { createG2Routes } from '../routes/g2-routes'
import { MCP_TASKS_PATH, createMcpTasksRoutes } from '../routes/mcp-tasks-routes'
import { ClaudeCodeRunner } from '../services/terminal/claude-code-runner'
import { createTerminalRoutes, feedChannelEvent } from '../routes/terminal-routes'
import { McaConnectionManager } from '../services/mca-connection-manager'
import { RemoteDeviceGateway } from '../services/remote-device-gateway'
import { RemoteKeepaliveService } from '../services/remote-keepalive-service'
import { MongoRemoteDeviceBindingRegistry } from '../models/remote-device-bindings'
import { RemoteTransferService } from '../services/remote-transfer-service'
import { TermHostManager } from '../services/terminal/term-host'
import { TerminalStreamServer } from '../services/terminal/stream-server'
import { McaStreamRelay } from '../services/mca-stream-relay'
import { RemoteOfflineNotifier } from '../services/remote-offline-notifier'
import { createAuthManagerKeyResolver } from '../services/remote-device-key-resolver'
import { MongoRemoteDeviceRegistry } from '../models/remote-devices'
import { ActionBridgeManager } from "../services/workflow-action-bridge"
import { WorkflowToolExecutor } from "../services/workflow-tool-executor"
import { ensureWorkflowIndexes } from "@teros/workflows/models"
import { ResumeService } from '../services/resume-service'
import { InstanceRegistry } from '../services/instance-registry'
import { FlowWebhookService } from '../services/flow-webhook-service'
import { FlowEventService } from '../services/flow-event-service'
import { FlowWebhookHandler } from '../handlers/flow-webhook-handler'
import { UpgradeRequiredError, HoursExhaustedError, PaymentDueError } from '../services/billing-gate'
import { getEmailService, isEmailConfigured } from '../services/email-service'
import { setTodoBusDispatch } from '../services/todo-event-emitters'
import { runMcaBootSync } from '../services/mca-boot-sync'
import { runMigrations } from '../migrations/runner'
import { ensureAllIndexes } from '../db/indexes'
import { createHttpHandler } from './http-server'
import { registerDependencies } from './container-setup'
import { notifyProcessManagerReady } from './process-manager'
import { killForeignPortHolders } from '../lib/port-ownership'
import { type BackfillMarker, runCoreAppsBackfillOnce } from './core-apps-backfill'
import { AgentUsageSentryAlerts } from '../services/agent-usage-sentry-alerts'
import { createMetricsRoute } from '../routes/metrics-routes'
import { createAgentAppsStorageRoutes } from '../routes/agent-apps-storage-routes'
import { seedBillingPlans, seedDefaultTerosProviderConfig } from '../models/billing'
import { resolveApiToken } from '../auth/api-tokens'

export interface BootstrapInput {
  container: Container
  db: Db
  mongoClient: MongoClient
  secretsManager: SecretsManager
  authManager: AuthManager
  mcaOAuth: McaOAuth
}

/**
 * Bootstrap the full server: wires all services, starts HTTP + WebSocket servers.
 * Returns a teardown function for graceful shutdown.
 */
export async function bootstrapServer({
  container,
  db,
  mongoClient,
  secretsManager,
  authManager,
  mcaOAuth,
}: BootstrapInput): Promise<void> {
  // Register all dependencies in the DI container
  registerDependencies(container, db, secretsManager, authManager, mcaOAuth)
  await container.init()
  console.log('Container initialized')

  // -------------------------------------------------------------------------
  // EMAIL SERVICE
  // -------------------------------------------------------------------------

  if (isEmailConfigured(secretsManager)) {
    getEmailService(db)
  }

  // -------------------------------------------------------------------------
  // AUTH SERVICES
  // -------------------------------------------------------------------------

  const authService = initAuthService(db)
  console.log('AuthService initialized')

  // Dev auto-login (local only): resolved once here, logs loudly when on or refused
  initDevAutologin()

  // Security audit logger (Req 6.5.1)
  auditLogger.init(db)
  console.log('AuditLogger initialized')

  // Google OAuth (optional)
  const oauthSecrets = secretsManager.system('oauth')
  if (oauthSecrets?.google?.clientId && oauthSecrets?.google?.clientSecret) {
    initGoogleAuth(db, {
      clientId: oauthSecrets.google.clientId,
      clientSecret: oauthSecrets.google.clientSecret,
      redirectUri:
        oauthSecrets.google.redirectUri ||
        `http://localhost:${config.server.port}/auth/google/callback`,
    })
    enableSocialSignIn('google')
    console.log('Google OAuth initialized')
  } else {
    console.log('Google OAuth: not configured')
  }

  // Microsoft OAuth (optional)
  if (oauthSecrets?.microsoft?.clientId && oauthSecrets?.microsoft?.clientSecret) {
    initMicrosoftAuth(db, {
      clientId: oauthSecrets.microsoft.clientId,
      clientSecret: oauthSecrets.microsoft.clientSecret,
      redirectUri:
        oauthSecrets.microsoft.redirectUri ||
        `http://localhost:${config.server.port}/auth/microsoft/callback`,
      tenant: oauthSecrets.microsoft.tenantId || 'common',
    })
    enableSocialSignIn('microsoft')
    console.log('Microsoft OAuth initialized')
  } else {
    console.log('Microsoft OAuth: not configured')
  }

  // GitHub OAuth (optional)
  if (oauthSecrets?.github?.clientId && oauthSecrets?.github?.clientSecret) {
    initGitHubAuth(db, {
      clientId: oauthSecrets.github.clientId,
      clientSecret: oauthSecrets.github.clientSecret,
      redirectUri:
        oauthSecrets.github.redirectUri ||
        `http://localhost:${config.server.port}/auth/github/callback`,
    })
    enableSocialSignIn('github')
    console.log('GitHub OAuth initialized')
  } else {
    console.log('GitHub OAuth: not configured')
  }

  console.log('MCA OAuth initialized')

  // -------------------------------------------------------------------------
  // GET SERVICES FROM CONTAINER
  // -------------------------------------------------------------------------

  const sessionManager = container.get(Tokens.SessionManager)
  const channelManager = container.get(Tokens.ChannelManager)
  const mcaService = container.get(Tokens.McaService)
  const workspaceService = container.get(Tokens.WorkspaceService)
  const volumeService = container.get(Tokens.VolumeService)
  const usageService = container.get(Tokens.UsageService)
  const eventHandler = container.get(Tokens.EventHandler)
  const sessionStore = container.get(Tokens.SessionStore)
  const providerService = container.get(Tokens.ProviderService)
  const modelService = container.get(Tokens.ModelService)
  const skillService = container.get(Tokens.SkillService)
  const projectService = container.get(Tokens.ProjectService)
  const shareService = container.get(Tokens.ShareService)
  const desktopStateService = container.get(Tokens.DesktopStateService)
  const userService = container.get(Tokens.UserService)
  const identityService = container.get(Tokens.IdentityService)
  const sessionService = container.get(Tokens.SessionService)

  // Connect WorkspaceService to McaService (late binding to avoid circular deps)
  mcaService.setWorkspaceService(workspaceService)

  // Provision system apps when a workspace is created. Finds the owner's
  // superagents (workspaceId=null) and ensures they have access to system
  // apps in the new workspace. Idempotent — safe on every creation.
  const navbarPinsService = new NavbarPinsService(container.get(Tokens.Db), workspaceService, container.get(Tokens.PubSubService))
  workspaceService.setOnWorkspaceCreated(async (workspace) => {
    // NAV-REQ-7: a new workspace starts with its factory navbar pins.
    await navbarPinsService.seedFactoryPins(workspace.workspaceId, workspace.ownerId)
    const agentsCollection = container.get(Tokens.Db).collection('agents')
    const superagents = await agentsCollection
      .find({ ownerId: workspace.ownerId, workspaceId: { $in: [null, undefined] as any } })
      .toArray()
    for (const agent of superagents) {
      await mcaService.ensureProvisionedApps(agent.agentId, workspace.workspaceId)
    }
    if (superagents.length > 0) {
      console.log(
        `[WorkspaceService] Provisioned system apps for ${superagents.length} superagent(s) in workspace ${workspace.workspaceId}`,
      )
    }
  })

  // Connect WorkspaceService to AuthService/UserService (late binding to avoid circular deps)
  authService.setWorkspaceService(workspaceService)

  // Connect AgentProvisioningService to AuthService (late binding — provisioning
  // depends on McaService, which is built after AuthService).
  const provisioningService = new AgentProvisioningService(container.get(Tokens.Db), mcaService)
  authService.setProvisioningService(provisioningService)

  // Connect ProviderService to AuthService/UserService so new-user creation can
  // provision the default Teros provider (late binding — same DI shape as above).
  authService.setProviderService(providerService)

  // -------------------------------------------------------------------------
  // PUBSUB + EVENT WIRING
  // -------------------------------------------------------------------------

  const pubSubService = container.get(Tokens.PubSubService)
  await pubSubService.init()

  const feedbackService = new FeedbackService(db, pubSubService)
  console.log('FeedbackService initialized')

  pubSubService.setEventHandler(eventHandler.handleScheduledEvent.bind(eventHandler))
  pubSubService.setSessionManager(sessionManager)
  pubSubService.setWorkspaceService(workspaceService)
  sessionManager.setPubSubService(pubSubService)
  eventHandler.setPubSubService(pubSubService)
  // Lets WorkspaceService.createWorkspace broadcast `workspace.created` to the
  // owner's sessions on every creation path (WS domain, legacy WS, MCA tool).
  workspaceService.setPubSubService(pubSubService)

  const ptyManager = container.get(Tokens.PtyManager)
  // Terminal sessions live in per-workspace terminal hosts (tmux) that outlive
  // this process: re-attach to the ones still running before serving terminals.
  // TERMINAL_HOSTS=0 keeps the legacy one-docker-exec-per-session PTYs.
  if (process.env.TERMINAL_HOSTS !== '0') {
    ptyManager.useTermHosts(new TermHostManager({ stackId: process.env.TERMINAL_STACK_ID ?? db.databaseName }))
    void ptyManager.adoptTermHosts()
  }
  const terminalStream = new TerminalStreamServer(db, ptyManager)

  // MCA streams relay (spec 20261104_mca-streams.md): created once the MCA
  // connection manager exists (below); the WS handler resolves it lazily.
  let streamRelay: McaStreamRelay | null = null

  const mcaEventSubscriptionService = container.get(Tokens.MCAEventSubscriptionService)
  await mcaEventSubscriptionService.init()
  mcaEventSubscriptionService.setPubSubService(pubSubService)
  mcaEventSubscriptionService.setEventInjector(
    eventHandler.handleScheduledEvent.bind(eventHandler),
  )
  mcaEventSubscriptionService.setCreateChannelFn(
    async (userId, agentId, metadata) => channelManager.createChannel(userId, agentId, metadata),
  )
  mcaEventSubscriptionService.setGetAgentUserIdFn(async (agentId) => {
    const agent = await db.collection('agents').findOne({ agentId })
    return agent?.ownerId ?? null
  })
  // Capa 4 — resolver del owner del channel para defense-in-depth (TER-358).
  // Si un evento incluye userId en el payload, el subscription service lo
  // compara con channel.userId antes de inyectar el wake-up.
  mcaEventSubscriptionService.setGetChannelOwnerUserIdFn(async (channelId) => {
    const channel = await channelManager.getChannel(channelId as any)
    return channel?.userId ?? null
  })
  // Note: setInjectTextAndWakeFn is wired after wsHandler is created

  const boardSubscriptionService = container.get(Tokens.BoardSubscriptionService)
  boardSubscriptionService.setEventInjector(
    eventHandler.handleScheduledEvent.bind(eventHandler),
  )

  // To-do list events (todo/events spec — board parity): same two rails as
  // the board. Conversation subscriptions wake through the same injector;
  // every todo.* event is also published on the MCA event bus (with its
  // workspace in the envelope) so Automate starters, flows and generic
  // channel subscriptions can react to it.
  const todoSubscriptionService = container.get(Tokens.TodoSubscriptionService)
  todoSubscriptionService.setEventInjector(
    eventHandler.handleScheduledEvent.bind(eventHandler),
  )
  setTodoBusDispatch(async (event) => {
    await mcaEventSubscriptionService.dispatch({ topic: event.topic, payload: event.payload })
  })

  const boardService = container.get(Tokens.BoardService)
  const reviewClaimService = container.get(Tokens.ReviewClaimService)

  const boardEventService = container.get(Tokens.BoardEventService)
  // Board is an event emitter like any app: every board.* activity event is
  // published on the MCA event bus (with its workspace in the envelope) so
  // subscriptions, flows and Automate starters can react to it.
  boardEventService.setEventDispatcher(async (topic, payload) => {
    await mcaEventSubscriptionService.dispatch({ topic, payload })
  })

  const featureFlagService = container.get(Tokens.FeatureFlagService)
  await featureFlagService.syncRegistry()
  featureFlagService.setPubSubService(pubSubService)
  featureFlagService.setSessionManager(sessionManager)
  // Sin workspace context, los workspace overrides son invisibles en el push
  // featureFlags.changed (TER-460)
  featureFlagService.setWorkspaceService(container.get(Tokens.WorkspaceService))

  // Connect FeatureFlagService to AuthService/UserService so new user creation
  // can read the access.auto-grant flag (late binding to avoid circular deps).
  authService.setFeatureFlagService(featureFlagService)

  const autoplayService = container.get(Tokens.AutoplayService)
  const todoAutoplayService = container.get(Tokens.TodoAutoplayService)

  // -------------------------------------------------------------------------
  // BILLING — seed (indexes: src/db/indexes.ts, applied after migrations)
  // -------------------------------------------------------------------------
  await seedBillingPlans(db)

  // Seed default Teros provider config from existing Fireworks system secret
  const fwSecrets = secretsManager.system<{ apiKey: string }>('fireworks')
  if (fwSecrets?.apiKey) {
    await seedDefaultTerosProviderConfig(db, fwSecrets.apiKey)
  } else {
    console.log('[Billing] No Fireworks system secret found — skipping default Teros provider config seed')
  }

  const mcaManager = container.has(Tokens.McaManager) ? container.get(Tokens.McaManager) : null
  if (mcaManager) {
    if (config.agentApps.enabled) {
      const stationCount = Object.keys(config.agentApps.stations).length
      const defaultUrl = config.agentApps.defaultStationUrl ?? 'none'
      console.log(`Agent Apps Bridge initialized (${stationCount} stations, default: ${defaultUrl})`)

      // Fire-and-forget catalog discovery from all stations
      const bridge = mcaManager as any
      if (typeof bridge.discoverApps === 'function') {
        setImmediate(async () => {
          try {
            const result = await bridge.discoverApps()
            console.log(`[AgentApps] Catalog discovery: ${result.discovered.length} apps found, ${result.errors.length} errors`)

            // Persist discovered apps to mca_catalog
            for (const app of result.discovered) {
              const now = new Date().toISOString()
              await db.collection('mca_catalog').updateOne(
                { mcaId: app.appId },
                {
                  $set: {
                    name: app.name,
                    description: `Agent App: ${app.name}`,
                    tools: app.tools.map((t: any) => t.name),
                    status: 'active',
                    updatedAt: now,
                    'runtime.transport': 'agent-apps',
                    'runtime.stationUrl': app.stationUrl,
                    'runtime.stationId': app.stationId,
                    'runtime.version': app.version,
                    availability: { enabled: true, hidden: false, system: false, multi: true, role: 'user' },
                  },
                  $setOnInsert: { mcaId: app.appId, createdAt: now },
                },
                { upsert: true },
              )

              // Populate static tools cache on the bridge
              if (typeof bridge.setStaticToolsForMca === 'function') {
                bridge.setStaticToolsForMca(app.appId, app.tools.map((t: any) => ({
                  name: t.name,
                  description: t.description,
                  inputSchema: {
                    type: 'object',
                    properties: t.parameters?.properties ?? {},
                    required: t.parameters?.required,
                  },
                  ...(t.annotations ? { annotations: t.annotations } : {}),
                })))
              }
            }
          } catch (err) {
            console.error('[AgentApps] Catalog discovery failed:', err)
          }
        })
      }
    } else {
      const mcaBasePath = resolve(config.mca.basePath!)
      console.log(`MCA Manager initialized (base path: ${mcaBasePath})`)
    }
  }

  console.log('Session store initialized')
  if (secretsManager.hasSystem('anthropic')) {
    console.log('LLM support: Anthropic API key configured (system secret)')
  } else {
    console.log('LLM support: No system Anthropic key — users must configure their own provider')
  }

  // -------------------------------------------------------------------------
  // HTTP HANDLERS
  // -------------------------------------------------------------------------

  const httpAuthHandler = new HttpAuthHandler(sessionManager, secretsManager)
  const githubAppService = new GitHubAppService(
    db,
    authManager,
    mcaOAuth,
    db.collection('mca_catalog'),
  )
  const githubWebhookHandler = new GitHubWebhookHandler(githubAppService, secretsManager)
  // F4·C1 — Latitude signal webhook. Present only when the HMAC secret is set;
  // absent → the endpoint 404s and no badge is ever recorded (product identical).
  const latitudeWebhookSecret = process.env.LATITUDE_WEBHOOK_SECRET
  const latitudeWebhookHandler = latitudeWebhookSecret
    ? new LatitudeWebhookHandler(
        container.get(Tokens.LatitudeSignalIndex),
        latitudeWebhookSecret,
        process.env.LATITUDE_BASE_URL,
        createLogger('LatitudeWebhookHandler'),
      )
    : undefined
  const appWebhookHandler = new AppWebhookHandler(
    mcaService,
    secretsManager,
    mcaEventSubscriptionService,
  )
  // Stripe webhook (FASE 4) — only wired when Stripe is configured.
  const stripePaymentService = container.get(Tokens.StripePaymentService)
  const stripeWebhookHandler = stripePaymentService.isEnabled()
    ? new StripeWebhookHandler(db, stripePaymentService, createLogger('StripeWebhookHandler'))
    : undefined
  const httpMcaAuthHandler = new HttpMcaAuthHandler(
    mcaOAuth,
    mcaService,
    authService,
    secretsManager,
    workspaceService,
    githubAppService,
  )
  const httpUploadHandler = new HttpUploadHandler(db, authService, pubSubService)
  const httpMediaHandler = new HttpMediaHandler(authService, mcaManager?.getContainerManager())
  const httpFileHandler = new HttpFileHandler(db, authService, volumeService, workspaceService, channelManager)
  const httpShareHandler = new HttpShareHandler(
    db,
    volumeService,
    workspaceService,
    shareService,
  )

  const adminRoutes = createAdminRoutes({ db, secretsManager, pubSubService, sessionManager })
  const boardRoutes = createBoardRoutes({ boardService, workspaceService, sessionManager })
  const automateModel = new AutomateModel(db)
  const automateRunner = new AutomateRunner({
    db,
    model: automateModel,
    boardService,
    handleScheduledEvent: eventHandler.handleScheduledEvent.bind(eventHandler),
    actionBridgeManager: null, // injected below once ActionBridgeManager exists
    pubSubService,
  })
  const automateRoutes = createAutomateRoutes({ model: automateModel, runner: automateRunner, db })
  // v2 non-blocking interactions: awaiting-auth wake pointers, shared between
  // the resource routes (show-app-auth registers) and the OAuth callback
  // (setOnAppAuthReady below consumes + wakes).
  const awaitingAuth = new AwaitingAuthRegistry()
  const mcaCallbackRoutes = createMcaCallbackRoutes({
    db,
    secretsManager,
    authManager,
    workspaceService,
    userService,
    volumeService,
    provisioningService,
    // Singleton del contenedor: WebSocketHandler le wirea setOnToolCacheInvalidate,
    // así el auto-grant de install-app refresca las tools de conversaciones activas.
    mcaService,
    mcaManager,
    pubSubService,
    mcaEventSubscriptionService,
    containerManager: mcaManager?.getContainerManager(),
    // Refresh lazy del access_token OAuth al servir /secrets/user (TER-388):
    // el backend es el único dueño del refresh_token (rotation-safe).
    mcaOAuth,
    // Capa 2 (TER-358): resolver del owner del channel para validar
    // cross-channel subscriptions desde MCAs.
    getChannelOwnerUserIdFn: async (channelId: string) => {
      const channel = await channelManager.getChannel(channelId as any)
      return channel?.userId ?? null
    },
    // Lazy binding: wsHandler is created after mcaCallbackRoutes, so we
    // capture it via closure. This mirrors the getWakeUpCallback pattern.
    invalidateToolCache: async (agentId: string) => {
      if (wsHandlerRef) {
        await wsHandlerRef.getMessageHandler().invalidateToolCache(agentId)
      }
    },
    // v2 non-blocking interactions: awaiting-auth wake pointers. show-app-auth
    // registers (userId, appId) → channelId; the OAuth callback consumes the
    // entry and wakes the channel's agent ("the user connected X").
    awaitingAuth,
    // Agent secret tools (20261031): set-app-secret's post-write redaction
    // sweep runs over the calling channel through the ChannelManager.
    channelManager,
  })
  const providerOAuthRoutes = createProviderOAuthRoutes({ db, providerService, sessionManager })

  // G2 routes — lazy wakeUpCallback (wsHandler created after httpHandler)
  let wsHandlerRef: WebSocketHandler | null = null

  // v2 non-blocking interactions (docs/specs/20261024_non-blocking-user-interactions.md):
  // auth-ready return path. show-app-auth registers (userId, appId) → channelId
  // in the awaitingAuth registry (passed to mcaCallbackRoutes above); when the
  // OAuth callback completes, this hook consumes the entry and wakes that
  // channel's agent with "the user connected X". Lazy binding via
  // wsHandlerRef because the MessageHandler is created later in the boot.
  mcaOAuth?.setOnAppAuthReady((userId: string, appId: string) => {
    const entry = awaitingAuth.consume(userId, appId)
    if (!entry) return
    const authLog = createLogger('AppAuthReady')
    authLog.info({ channelId: entry.channelId, appId, userId }, 'Auth ready — waking awaiting channel')
    void (async () => {
      try {
        if (!wsHandlerRef) {
          authLog.warn({ channelId: entry.channelId }, 'Auth-ready wake: wsHandler not ready yet')
          return
        }
        const messageHandler = wsHandlerRef.getMessageHandler()
        await messageHandler.handleAuthReadyWake(entry.channelId, appId)
      } catch (err) {
        authLog.error({ err, channelId: entry.channelId, appId }, 'Auth-ready wake failed')
      }
    })()
  })
  const g2Routes = createG2Routes({
    db,
    channelManager,
    authService,
    providerService,
    pubSubService,
    getWakeUpCallback: () => {
      if (!wsHandlerRef) throw new Error('[G2] wsHandler not yet initialized')
      return wsHandlerRef.getAgentWakeUpCallback()
    },
  })

  // Tasks MCP endpoint — the Claude Code runner's tool bridge (CCR-REQ-4).
  const mcpTasksRoutes = createMcpTasksRoutes({ db })

  // Terminal routes — Even Terminal /api/* SSE + REST contract for G2 Terminal Mode.
  // Reuses the same G2 token auth and wakeUpCallback as g2Routes.
  const terminalRoutes = createTerminalRoutes({
    db,
    channelManager,
    getWakeUpCallback: () => {
      if (!wsHandlerRef) throw new Error('[Terminal] wsHandler not yet initialized')
      return wsHandlerRef.getAgentWakeUpCallback()
    },
    // Wire permission resolution to the in-memory PermissionManager so that
    // when the G2 Terminal user taps "Allow" or "Deny", the agent loop unblocks.
    resolvePermission: (requestId: string, granted: boolean) => {
      if (!wsHandlerRef) return Promise.resolve()
      return wsHandlerRef.getMessageHandler().handlePermissionResponse(requestId, granted)
    },
  })

  // -------------------------------------------------------------------------
  // HTTP SERVER
  // -------------------------------------------------------------------------

  // Prometheus /metrics endpoint exposing usage instrumentation gauges + counters.
  // Bound lazily — the buffer/reconciler/rollup instances are read from the
  // container, and the route is wired into createHttpHandler below.
  const metricsRoute = createMetricsRoute({
    buffer: container.get(Tokens.UsageEventBuffer),
    reconciler: container.get(Tokens.AgentUsageReconciler),
    rollup: container.get(Tokens.AgentUsageRollupJob),
    tracker: container.get(Tokens.AgentHoursTracker),
    resetCron: container.get(Tokens.BillingResetCron),
    reconciliationCron: container.get(Tokens.BillingReconciliationCron),
    chargeCron: container.get(Tokens.BillingChargeCron),
    db, // model-health series (TER-616/R5)
    latitudeExport: container.get(Tokens.LatitudeExportMetrics), // F3a export health
    latitudeScores: container.get(Tokens.LatitudeScoreMetrics), // F4·C0 score emitter health
  })

  // Costs API (/api/costs/*) — read-only inference-cost aggregations for the
  // external panel (task_4b1fe21d28b84452). Auth: static per-environment API
  // key (task_6de67c22b163387a) — X-API-Key header. Key source: the costs
  // system secret (.secrets/system/costs.json → { apiKey }), falling back to
  // the COSTS_API_KEY env var. One key per environment (raw / prod), rotable
  // without a code deploy (edit secret/env + restart). Null → disabled (404).
  // No METRICS_TOKEN fallback: mixing credential scopes is exactly what the
  // API-key task forbids — the costs key authorizes ONLY /api/costs/*.
  const costsApiKey = resolveCostsApiKeyFrom(
    secretsManager.getSystemFresh("costs")?.apiKey as string | undefined,
    process.env.COSTS_API_KEY,
  )
  const costsEnv = resolveCostsEnv(
    process.env.SERVER_BASE_URL,
    process.env.NODE_ENV,
    process.env.COSTS_ENV,
  )
  costsAccessLogger.init(db)
  const costsRoutes = createCostsRoutes({
    db,
    apiKey: costsApiKey,
    env: costsEnv,
    trustProxy: config.security.trustProxy,
  })

  // Mongo-backed rate limiter — shared by the HTTP edge and the /ws handshake.
  // Null (disabled) only when RATE_LIMIT_ENABLED=false.
  const rateLimiter = config.security.rateLimit.enabled
    ? new RateLimiter(db, createLogger('RateLimiter'))
    : null

  // Agent Apps routes (station → host push announcements)
  let agentAppsRoutes: ((req: import('http').IncomingMessage, res: import('http').ServerResponse, url: string) => Promise<boolean>) | undefined
  if (config.agentApps.enabled && mcaManager) {
    const { createAgentAppsRoutes } = await import('../routes/agent-apps-routes')
    agentAppsRoutes = createAgentAppsRoutes({
      db,
      bridge: mcaManager as any,
      announceToken: config.agentApps.stationToken,
      objectStoragePath: config.agentApps.objectStoragePath,
      onCatalogUpdated: () => {
        // Broadcast to all connected WebSocket clients that the catalog changed.
        // Clients will refetch app.list-catalog on receiving this.
        const msg = JSON.stringify({ type: 'event', event: 'catalog:updated' })
        for (const client of wss.clients) {
          if (client.readyState === 1) client.send(msg)
        }
      },
    })
  }

  // Agent Apps storage routes — ALWAYS registered (no bridge needed).
  // These expose the CallbackHandlers as standalone HTTP endpoints so any
  // MCA can use the storage layer without AGENT_APPS_ENABLED=true.
  const agentAppsStorageRoutes = createAgentAppsStorageRoutes({
    db,
    objectStoragePath: config.agentApps.objectStoragePath,
    // Authenticate this standalone surface with the per-MCA callback token
    // (datastore-isolation P0a) — same container manager the /mca/callback
    // path uses.
    containerManager: mcaManager?.getContainerManager(),
    // F1 containment: the CORS allowlist feeds the CSP frame-ancestors
    // directive on /objects (our own app origins may embed, nobody else).
    security: { corsAllowedOrigins: config.security.corsAllowedOrigins },
  })

  // AgentApps storage routes are always on (not gated behind AGENT_APPS_ENABLED).
  // The static collection indexes are now created via migration
  // 20260920_001_agent_apps_storage_indexes (registered in the migration runner).
  // Dynamic collection indexes are still ensured at runtime by CallbackHandlers
  // on the first storage_put to each agent_app_storage_* collection.
  console.log('AgentApps storage routes initialized')

  // -------------------------------------------------------------------------
  // FLOW WEBHOOK SERVICE (Phase 4)
  // -------------------------------------------------------------------------
  // Created before HTTP handler so the handler can be passed to createHttpHandler.
  // The ActionBridgeManager is set later (after MCA connection manager block).
  const flowWebhookService = new FlowWebhookService(db)
  const flowWebhookHandler = new FlowWebhookHandler(flowWebhookService)

  // -------------------------------------------------------------------------
  // FLOW EVENT SERVICE (Phase 4)
  // -------------------------------------------------------------------------
  const flowEventService = new FlowEventService(db)

  const httpHandler = createHttpHandler({
    adminRoutes,
    boardRoutes,
    automateRoutes,
    mcaCallbackRoutes,
    providerOAuthRoutes,
    g2Routes,
    terminalRoutes,
    metricsRoute,
    costsRoutes,
    mcpTasksRoutes,
    authHandler: httpAuthHandler,
    mcaAuthHandler: httpMcaAuthHandler,
    githubWebhookHandler,
    latitudeWebhookHandler,
    appWebhookHandler,
    flowWebhookHandler,
    stripeWebhookHandler,
    uploadHandler: httpUploadHandler,
    mediaHandler: httpMediaHandler,
    fileHandler: httpFileHandler,
    shareHandler: httpShareHandler,
    eventHandler,
    mcaEventSubscriptionService,
    sessionManager,
    mcaManager,
    agentAppsRoutes,
    agentAppsStorageRoutes,
    rateLimiter: rateLimiter ?? undefined,
    db,
  })

  const httpServer = createServer(httpHandler)

  // -------------------------------------------------------------------------
  // WEBSOCKET SERVER
  // -------------------------------------------------------------------------

  // Voice Mode v2 F4: late-bound voice loop resolver. The VoiceLoop is
  // constructed AFTER the WebSocketHandler (it needs the messageHandler the
  // wsHandler owns), so the admin-api voice-telemetry actions resolve it
  // lazily through this holder — null until the loop exists, then the loop.
  let voiceLoopRef: import('../handlers/voice-loop').VoiceLoop | null = null

  const wss = new WebSocketServer({ noServer: true })
  console.log('WebSocket server created (noServer mode)')

  const wsHandler = new WebSocketHandler(wss, sessionManager, channelManager, db, sessionStore, {
    clock: container.get(Tokens.Clock),
    secretsManager,
    mcaManager,
    mcaOAuth,
    authManager,
    workspaceService,
    navbarPinsService,
    volumeService,
    boardService,
    automateRunner,
    autoplayService,
    eventHandler,
    pubSubService,
    mcaEventSubscriptionService,
    boardSubscriptionService,
    ptyManager,
    terminalStream,
    getStreamRelay: () => streamRelay,
    userService,
    identityService,
    sessionService,
    providerService,
    modelService,
    mcaService,
    shareService,
    skillService,
    projectService,
    desktopStateService,
    featureFlagService,
    feedbackService,
    latitudeScoreEmitter: container.get(Tokens.LatitudeScoreEmitter),
    stripePaymentService: container.get(Tokens.StripePaymentService),
    agentUsageSessionService: container.get(Tokens.AgentUsageSessionService),
    toolExecutionService: container.get(Tokens.ToolExecutionService),
    agentUsageHealthDeps: {
      buffer: container.get(Tokens.UsageEventBuffer),
      reconciler: container.get(Tokens.AgentUsageReconciler),
      rollup: container.get(Tokens.AgentUsageRollupJob),
    },
    latitudeSignalIndex: container.get(Tokens.LatitudeSignalIndex),
    latitudeReadClient: container.get(Tokens.LatitudeReadClient),
    // Voice Mode v2 F4: admin-api.voice-telemetry-* resolves the loop lazily
    // (it is constructed below, after this handler — see voiceLoopRef).
    getVoiceLoop: () => voiceLoopRef,
    flowWebhookService,
    flowEventService,
  })

  wsHandlerRef = wsHandler

  // v2 non-blocking interactions: the MessageHandler needs the awaiting-auth
  // registry so its resolution hooks can compute the full awaiting_user state
  // (forms + permissions + auth) before broadcasting the clear.
  wsHandler.getMessageHandler().setAwaitingAuthRegistry(awaitingAuth)

  eventHandler.setAgentWakeUpCallback(wsHandler.getAgentWakeUpCallback())
  autoplayService.setWakeUpCallback(wsHandler.getAgentWakeUpCallback())
  // Notify the supervising channel when a stuck task is auto-blocked (TER-650/G2).
  autoplayService.setEventHandler(eventHandler)
  autoplayService.startPeriodicScheduler()
  // To Do autoplay (TODOAP): same wake-up callback and 60 s scheduler as the
  // board's; the message handler sets the running flag of linked To Do tasks
  // and the todo actions reach the service through the MCA action deps.
  todoAutoplayService.setWakeUpCallback(wsHandler.getAgentWakeUpCallback())
  wsHandler.getMessageHandler().setTodoAutoplayService(todoAutoplayService)
  setMcaActionDeps({ todoAutoplay: todoAutoplayService, todoSubscriptions: todoSubscriptionService })
  // Claude Code runner (CCR): tasks of `runner: 'claude-code'` agents are worked
  // by a Claude Code session in the workspace's terminal host. The session
  // reaches the tasks MCP endpoint the way MCA containers reach the backend
  // (TEROS_TASKS_MCP_URL overrides, e.g. behind a public hostname).
  const claudeCodeRunner = new ClaudeCodeRunner({
    db,
    wsRouter: wsHandler.getWsRouter(),
    mcpUrl:
      process.env.TEROS_TASKS_MCP_URL ||
      `http://${process.env.MCA_CALLBACK_HOST || 'host.docker.internal'}:${config.server.callbackPort}${MCP_TASKS_PATH}`,
    broadcast: (workspaceId, node, action) => todoAutoplayService.broadcastNodeChanged(workspaceId, node, action),
  })
  todoAutoplayService.setClaudeCodeRunner(claudeCodeRunner)
  setMcaActionDeps({ claudeCodeRunner })
  todoAutoplayService.startPeriodicScheduler()

  // Bridge PubSub channel events → Terminal SSE for G2 Terminal Mode.
  // A global channel listener receives every broadcast to `channel:{channelId}`.
  // We parse the payload and feed it to the terminal provider that owns that
  // channel, which translates Teros events (message_chunk, tool_call,
  // permission_request, etc.) into Even Terminal's SSE vocabulary so the G2
  // glasses receive streaming text and permission dialogs.
  pubSubService.addGlobalChannelListener((channelId: string, payload: string) => {
    try {
      const event = JSON.parse(payload) as Record<string, unknown>
      feedChannelEvent(channelId, event)
    } catch {
      // ignore parse errors — the payload may not be a JSON object
    }
  })

  mcaEventSubscriptionService.setInjectTextAndWakeFn(async ({ channelId, text, senderAgentId }) => {
    const wakeUpCallback = wsHandler.getAgentWakeUpCallback()
    await wakeUpCallback(channelId, senderAgentId ?? 'system', text)
  })

  // Flow Event Service (Phase 4) — hook into event dispatch so flows
  // with event triggers are executed when matching events occur.
  mcaEventSubscriptionService.setFlowEventCallback(async (event) => flowEventService.onEventDispatched(event))

  // AutomateRunner — fires automate starters with event triggers on dispatch.
  mcaEventSubscriptionService.setAutomateEventCallback(async (event) => automateRunner.onEventDispatched(event))

  // -------------------------------------------------------------------------
  // VOICE HANDLER
  // -------------------------------------------------------------------------

  const voiceHandler = new VoiceHandler(
    db,
    sessionManager,
    channelManager,
    secretsManager,
    wsHandler.getMessageHandler(),
    mcaEventSubscriptionService,
    authService,
    workspaceService,
    featureFlagService,
  )
  voiceHandler.setPubSubService(pubSubService)
  voiceHandler.setSessionStore(sessionStore)

  // Voice Mode v2 — F1a: the native voice loop (STT Deepgram + Teros agent as
  // the brain + TTS ElevenLabs Flash). Dispatched per connection via the
  // `voice.engine` feature flag ('elevenlabs' = legacy ConvAI proxy (default),
  // 'native' = this loop) — resolved at connect time, so switching the flag
  // takes effect on the next voice connection WITHOUT a backend restart.
  const voiceLoop = new VoiceLoop(
    db,
    channelManager,
    secretsManager,
    wsHandler.getMessageHandler(),
    workspaceService,
    featureFlagService,
    authService,
  )
  voiceLoop.setPubSubService(pubSubService)
  // Voice Mode — overheard → LLM context (task_2c87e848dd2e4161): the loop
  // mirrors every overheard utterance into session_messages (the LLM context
  // store) as it is heard, so text turns after a voice session keep the spoken
  // context. Without this wiring the mirror silently no-ops
  // (persistOverheardToSessionStore guards on the store) and the overheard
  // only reaches the LLM if it happens to ride an activated turn. The legacy
  // handler below (AF-5) had this wiring; the loop was missing it.
  voiceLoop.setSessionStore(sessionStore)
  // Voice Mode v2 F4: the loop now exists — the admin-api voice-telemetry
  // actions (wired above through getVoiceLoop) start resolving it.
  voiceLoopRef = voiceLoop
  // Voice Mode v2 — F2b (REQ-8): wire the loop into the text engine so tool
  // executors for channels with an ACTIVE native voice session get the
  // set_mode/get_mode/pause_listening built-ins (the agent's own door to the
  // mode axis — "cállate media hora que tengo una reunión", AC-7).
  wsHandler.getMessageHandler().setVoiceLoop(voiceLoop)
  console.log('VoiceLoop initialized (voice.engine flag: elevenlabs=native dispatch at connect)')
  // Wire VoiceHandler → MessageHandler so the text engine can check whether
  // a voice session is active before processing a text message. This prevents
  // duplicate responses when voice mode is active (ElevenLabs + text engine)
  // and unwanted responses in silent mode.
  wsHandler.getMessageHandler().setVoiceHandler(voiceHandler)
  wsHandler.getMessageHandler().setFeatureFlagService(featureFlagService)
  // 🛡️ Teros Guard (docs/specs/security/20261106_teros-guard.md): service +
  // cached global flag (`tools.teros-guard`, fail-safe OFF). The flag refreshes
  // on a 30 s cadence — a rollout flip takes effect on the next executor use,
  // no restart. Guard OFF by default (Fase 1 = core only).
  wsHandler
    .getMessageHandler()
    .setTerosGuard(
      new TerosGuardService(db, providerService),
      createCachedGlobalFlag(featureFlagService, 'tools.teros-guard', {
        onError: (err) => console.warn('[TerosGuard] flag resolve failed:', err),
      }),
    )
  console.log('VoiceHandler initialized')

  // -------------------------------------------------------------------------
  // MCA CONNECTION MANAGER
  // -------------------------------------------------------------------------

  let mcaConnectionManager: McaConnectionManager | undefined
  let remoteDeviceGateway: RemoteDeviceGateway | undefined
  if (mcaManager) {
    const wsTokenExpiryMs = process.env.CONTAINER_PROVIDER === 'kubernetes' ? 120000 : 30000
    const actionBridgeManager = new ActionBridgeManager(
      db,
      boardService,
      pubSubService,
      mcaManager ? new WorkflowToolExecutor(mcaManager as any) : undefined,
    )

    flowWebhookService.setActionBridgeManager(actionBridgeManager)
    flowEventService.setActionBridgeManager(actionBridgeManager)
    // AutomateRunner needs the engine bridge for start-flow actions.
    automateRunner.setActionBridgeManager(actionBridgeManager)
    // MCA actions (datastore-isolation P1b): the `workflows` capability runs the
    // engine in-process and syncs a flow's triggers through Automate (the same
    // reconcile as `automate.sync-flow-triggers`); the `memory` capability opens
    // Qdrant / OpenAI lazily from the MCA's credentials file via secretsManager;
    // the `todo` capability reads `path`-delivered input/output files from the
    // calling workspace's volume via volumeService.
    // The callback router was created earlier, so inject the dependencies here.
    setMcaActionDeps({ actionBridgeManager, automateModel, workspaceService, secretsManager, volumeService })
    mcaConnectionManager = new McaConnectionManager(db, {
      secretsManager,
      authManager,
      channelManager,
      boardService,
      reviewClaimService,
      sessionManager,
      wsRouter: wsHandler.getWsRouter(),
      pubSubService,
      mcaEventSubscriptionService,
      boardSubscriptionService,
      workspaceService,
      volumeService,
      actionBridgeManager,
      tokenExpiryMs: wsTokenExpiryMs,
    })
    mcaConnectionManager.initWebSocketServer(httpServer)
    {
      const cm = mcaConnectionManager
      streamRelay = new McaStreamRelay(db, {
        sendToMca: (appId, message) => cm.send(appId, message),
        declaresStreams: (appId) => cm.declaresStreams(appId),
      })
      cm.setStreamRelay(streamRelay)
      console.log('📡 MCA streams relay ready (/ws/stream)')
    }
    mcaManager.setConnectionManager(mcaConnectionManager)
    mcaOAuth.setConnectionManager(mcaConnectionManager)

    // Teros Remote gateway (docs/specs/remote/teros-remote.md): paired daemons
    // dial in on /ws/remote; tool calls on mca.teros.remote app instances are
    // routed through it by McaManager instead of spawning a container.
    const remoteDeviceRegistry = new MongoRemoteDeviceRegistry(db)
    const remoteDeviceBindingRegistry = new MongoRemoteDeviceBindingRegistry(db)
    remoteDeviceGateway = new RemoteDeviceGateway({
      registry: remoteDeviceRegistry,
      bindingRegistry: remoteDeviceBindingRegistry,
      resolveKey: createAuthManagerKeyResolver({
        authManager,
        registry: remoteDeviceRegistry,
        getApp: (appId) => mcaService.getApp(appId),
      }),
      // T-REM-5: the ack carries the workspace name so the daemon can print
      // "Paired with workspace X".
      getWorkspaceName: async (workspaceId) =>
        (await workspaceService.getWorkspace(workspaceId))?.name ?? null,
    })
    // Transfer plane (v0.7.0, REQ-14): pull-file/push-file ride dedicated
    // tunnel messages; this service is the workspace-volume end of the pipe.
    const remoteTransferService = new RemoteTransferService({
      gateway: remoteDeviceGateway,
      volumeService,
      workspaceService,
    })
    remoteDeviceGateway.setTransferHandler((appId, envelope) =>
      remoteTransferService.handleMessage(appId, envelope),
    )
    // Directory plane (v0.8.0): dir.op (volume manifest / delete) rides the tunnel too.
    remoteDeviceGateway.setDirOpHandler((appId, envelope) =>
      remoteTransferService.handleDirOp(appId, envelope),
    )
    remoteDeviceGateway.initWebSocketServer()
    mcaManager.setRemoteGateway(remoteDeviceGateway)
    mcaManager.setTransferService(remoteTransferService)
    console.log('RemoteDeviceGateway initialized (/ws/remote)')

    // Keep-alive / inactivity TTL (v1.1.0, Pablo 2026-10-30): renew live
    // tunnels with a daily `keepalive` while the user is active; after 72h
    // without signs of life, order a clean `stop` and release the binding.
    // The returning user gets the guided "run teros-remote start" notice via
    // the offline diagnosis (stopped_inactive).
    const remoteKeepaliveService = new RemoteKeepaliveService({
      db,
      registry: remoteDeviceRegistry,
      bindingRegistry: remoteDeviceBindingRegistry,
      gateway: remoteDeviceGateway,
    })
    remoteKeepaliveService.start()
    console.log('RemoteKeepaliveService started (daily keepalive, 72h inactivity TTL)')

    // T-REM-7: notify the user in-channel when a remote machine is unreachable
    // (and when it comes back). The notifier owns the 5-min per-device rate
    // limit; the EventHandler does the actual persist + broadcast.
    const remoteOfflineNotifier = new RemoteOfflineNotifier({
      notify: async (n) => {
        const result = await eventHandler.handleScheduledEvent({
          channelId: n.channelId,
          message: n.message,
          eventType: n.kind,
          wakeUpAgent: false, // informational — the agent already got the tool error
          metadata: n.metadata as any,
        })
        // T-REM-14: surface failure as an exception so the notifier does NOT
        // mark the cooldown — the user never saw the message, so the next
        // retry must be allowed to post again.
        if (!result.success) {
          console.warn(
            { channelId: n.channelId, kind: n.kind, error: result.error },
            '[Remote] channel notification failed',
          )
          throw new Error(`channel notification failed: ${result.error ?? 'unknown'}`)
        }
      },
    })
    mcaManager.setRemoteOfflineNotifier(remoteOfflineNotifier)
    // "Back online": the gateway fires device:online without any channel
    // context; the notifier remembers which channel last heard about the
    // device and posts the resolution there.
    remoteDeviceGateway.on('device:online', (device) => {
      const channelId = remoteOfflineNotifier.lastChannelFor(device.deviceId)
      if (!channelId) return
      void remoteOfflineNotifier
        .notifyBackOnline(channelId, {
          deviceId: device.deviceId,
          name: device.name,
          hostname: device.hostname,
          appId: device.appId,
        })
        .catch((err) => console.warn('[Remote] back-online notification failed:', err))
    })

    mcaConnectionManager.on('mca:event', async (event) => {
      console.log(`[Main] MCA event received: topic=${event.topic ?? event.eventType} from ${event.appId}`)
      const topic = event.topic ?? event.eventType ?? 'unknown'
      const { appId, topic: _t, eventType: _e, ...payload } = event
      // Envelope: the workspace comes from the app record, never from the payload.
      const app = appId ? await db.collection('apps').findOne({ appId }, { projection: { ownerId: 1 } }) : null
      const ownerId = (app as { ownerId?: string } | null)?.ownerId
      const workspaceId = ownerId && (ownerId.startsWith('work_') || ownerId.startsWith('ws_')) ? ownerId : undefined
      await mcaEventSubscriptionService.dispatch({
        topic,
        payload: { ...payload, appId, workspaceId, occurredAt: new Date().toISOString() },
      })
    })

    mcaConnectionManager.on('mca:health', (appId, update) => {
      console.log(`[Main] MCA health update: ${appId} -> ${update.status}`)
      mcaManager.updateHealthFromWebSocket(appId, update.status, update.issues)
    })

    mcaConnectionManager.on('mca:send_message', async ({ channelId, agentId, message }) => {
      console.log(`[Main] MCA send_message: channelId=${channelId}, agentId=${agentId}`)
      try {
        const wakeUpCallback = wsHandler.getAgentWakeUpCallback()
        await wakeUpCallback(channelId, agentId, message)
      } catch (error) {
        console.error('[Main] Error processing MCA send_message:', error)
      }
    })

    mcaConnectionManager.on('mca:credentials_expired', async (appId, reason) => {
      console.log(`[Main] MCA credentials expired: ${appId} - ${reason}`)
      try {
        const app = await mcaService.getApp(appId)
        if (app) {
          console.log(`[Main] Attempting token refresh for ${appId}...`)
          const refreshResult = await mcaOAuth.refreshToken(app.ownerId, appId, app.mcaId)
          if (refreshResult.success) {
            console.log(`[Main] Token refreshed successfully for ${appId}, sending new credentials`)
            const credentials = await authManager.get(app.ownerId, appId)
            if (credentials) {
              const credentialsRecord: Record<string, string> = {}
              for (const [key, value] of Object.entries(credentials)) {
                if (value !== undefined && value !== null) {
                  credentialsRecord[key] = String(value)
                }
              }
              mcaConnectionManager?.sendCredentialsUpdate(appId, credentialsRecord)
              mcaManager.updateHealthFromWebSocket(appId, 'ready', [])
              return
            }
          } else {
            console.warn(`[Main] Token refresh failed for ${appId}: ${refreshResult.error}`)
          }
        }
      } catch (error) {
        console.error(`[Main] Error refreshing token for ${appId}:`, error)
      }
      mcaManager.updateHealthFromWebSocket(appId, 'not_ready', [
        { code: 'AUTH_EXPIRED', message: reason },
      ])
    })

    console.log('🔌 MCA Connection Manager initialized (WebSocket on /mca)')
  }

  // -------------------------------------------------------------------------
  // WEBSOCKET UPGRADE HANDLER
  // -------------------------------------------------------------------------

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname
    const url = new URL(request.url || '', `http://${request.headers.host}`)

    if (pathname === '/ws') {
      const doUpgrade = () =>
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request)
        })
      if (rateLimiter) {
        // Per-IP connect throttle — reject the handshake before it completes.
        void (async () => {
          const ip = extractClientIp(request, config.security.trustProxy)
          const decision = await rateLimiter.consume('ws-connect', ip, config.security.rateLimit.perIp)
          if (!decision.allowed) {
            socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${decision.retryAfterSeconds}\r\n\r\n`)
            socket.destroy()
            return
          }
          doUpgrade()
        })()
      } else {
        doUpgrade()
      }
    } else if (pathname === '/voice') {
      const sessionId = url.searchParams.get('sessionId')
      const apiToken = url.searchParams.get('apiToken') || undefined
      const agentId = url.searchParams.get('agentId')
      const existingChannelId = url.searchParams.get('channelId') || undefined
      const chatChannelId = url.searchParams.get('chatChannelId') || undefined
      // PoC 2026-10-31 (Pablo): the door that opens the session may ask for its
      // starting mode (the navbar presence starts in 'available'). Native loop only.
      const requestedMode = url.searchParams.get('mode') || undefined

      // Auth: either sessionId (user session) or apiToken (API token for tablets/devices)
      if (!agentId || (!sessionId && !apiToken)) {
        console.warn('[WebSocket] Voice connection missing auth (sessionId or apiToken) and agentId')
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        socket.destroy()
        return
      }

      // Feature flag guard + auth: voice.enabled must be true for this user
      ;(async () => {
        try {
          let userId: string

          if (apiToken) {
            // API token auth (unknown token or deleted/suspended user → 401)
            const tokenDoc = await resolveApiToken(db, apiToken)
            if (!tokenDoc) {
              console.warn('[WebSocket] Voice connection: invalid apiToken')
              socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
              socket.destroy()
              return
            }
            userId = tokenDoc.userId
          } else {
            // Session token auth
            const authResult = await authService.validateSession(sessionId!)
            if (!authResult.success || !authResult.user) {
              console.warn('[WebSocket] Voice connection: invalid session')
              socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
              socket.destroy()
              return
            }
            userId = authResult.user.userId
          }

          // Resolve user's workspace context for feature flag evaluation
          const userWorkspaces = await workspaceService.listUserWorkspaces(userId)
          const workspaceId = userWorkspaces[0]?.workspaceId

          const isVoiceEnabled = await featureFlagService.resolve('voice.enabled', {
            userId,
            workspaceId,
          })

          if (!isVoiceEnabled) {
            console.warn(
              `[WebSocket] Voice connection rejected: voice.enabled=false for user ${userId}`,
            )
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
            socket.destroy()
            return
          }

          // Flag is enabled — proceed with the WebSocket upgrade
          // For apiToken auth, use a synthetic sessionId (tak: prefix) so VoiceHandler
          // authenticateUser knows to validate via api_tokens instead of session store
          const effectiveSessionId = apiToken ? `tak:${apiToken}` : sessionId!

          // Voice Mode v2 — F1a: engine dispatch, per connection (voice.engine
          // flag: 'elevenlabs' = legacy ConvAI proxy (default), 'native' = the
          // native loop). Resolved HERE, at connect time — flipping the flag
          // switches the engine on the next voice connection, no restart needed.
          const voiceEngine = await featureFlagService.resolve('voice.engine', {
            userId,
            workspaceId,
          })
          const engineHandler =
            voiceEngine === 'native'
              ? voiceLoop
              : voiceHandler
          if (voiceEngine === 'native') {
            console.log(`[WebSocket] Voice connection using NATIVE engine (voice.engine=native) for user ${userId}`)
          }

          const wssVoice = new WebSocketServer({ noServer: true })
          wssVoice.handleUpgrade(request, socket, head, (ws) => {
            const connecting =
              voiceEngine === 'native'
                ? voiceLoop.handleConnection(ws, effectiveSessionId, agentId, existingChannelId, chatChannelId, requestedMode)
                : engineHandler.handleConnection(ws, effectiveSessionId, agentId, existingChannelId, chatChannelId)
            connecting
              .catch((error) => {
                console.error('[WebSocket] Voice connection error:', error)
                ws.close()
              })
          })
        } catch (error) {
          console.error('[WebSocket] Voice connection: feature flag check failed:', error)
          socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n')
          socket.destroy()
        }
      })()
    } else if (pathname === '/mca' && mcaConnectionManager) {
      mcaConnectionManager.handleUpgrade(request, socket, head)
    } else if (pathname === '/ws/remote' && remoteDeviceGateway) {
      remoteDeviceGateway.handleUpgrade(request, socket, head)
    } else if (pathname === '/ws/terminal') {
      terminalStream.handleUpgrade(request, socket, head)
    } else if (pathname === '/ws/stream' && streamRelay) {
      streamRelay.handleUpgrade(request, socket, head)
    } else {
      console.warn(`[WebSocket] Unknown upgrade path: ${pathname}`)
      socket.destroy()
    }
  })

  // -------------------------------------------------------------------------
  // MIGRATIONS + START SERVER
  // -------------------------------------------------------------------------

  if (secretsManager.hasSystem('admin')) {
    console.log('Admin API: enabled (key from .secrets/system/admin.json)')
  } else {
    console.log('Admin API: disabled (no .secrets/system/admin.json)')
  }

  if (config.security.trustProxy) {
    console.log('TRUST_PROXY: enabled — X-Forwarded-For is trusted for client-IP (rate limiting, /metrics gate)')
  } else {
    console.log(
      'TRUST_PROXY: disabled (default) — client IP is the direct TCP peer. ' +
        'If this server sits behind a reverse proxy (nginx/Traefik), every request ' +
        "appears to come from the proxy's IP: the per-IP rate limiter buckets all " +
        "traffic together, and if the proxy's IP falls in METRICS_ALLOWED_IPS (default " +
        'loopback + RFC1918), /metrics becomes reachable through the proxy by anyone. ' +
        'Set TRUST_PROXY=true.',
    )
  }

  // Migrations first, then indexes (GOV-4): a migration may have to fix data
  // before a unique index can be built, and every index is declared once in
  // src/db/indexes.ts. Index creation is idempotent and tolerant of equivalent
  // indexes, so later boots are no-ops. The HTTP server starts listening below.
  await runMigrations(db)
  const indexResult = await ensureAllIndexes(db)
  console.log(`[Indexes] ensured ${indexResult.indexes} indexes on ${indexResult.collections} collections`)
  // The workflow engine's collections are owned by @teros/workflows.
  if (mcaManager) await ensureWorkflowIndexes(db)

  // Dev auto-login (local only, guards already passed): seed dev@teros.local
  // when missing so the auto-login lands in a usable account. Never blocks boot.
  try {
    await maybeAutoSeedDevUser(db, getDevAutologin())
  } catch (err) {
    console.error('⚠ DEV AUTOLOGIN: seeding the dev user failed:', err)
  }

  // Automate runner (scheduler tick + event trigger execution) starts only
  // once migrations have run, so it never sees pre-v2 starter documents.
  // Leader-gated in multi-instance; per execution, billing-gated on the
  // starter's acting agent (TER-650/G6) and capped by the creator's daily
  // Automate execution quota (plan.automateDailyExecutionLimit).
  automateRunner.setLeaderElection(container.get(Tokens.LeaderElectionService))
  const automateQuota = new AutomateQuotaService(db, automateModel)
  // First refusal of a user's day: one WS notice to their live sessions
  // (toast + global banner + Automate window strip) and, when the refused
  // action was a channel message, a chat block in that channel — the same
  // 'upgrade_required' carrier HoursExhaustedWidget uses, disambiguated by
  // context.reason === 'automate_quota'. Never wakes an agent.
  automateQuota.setOnExhausted(async (starter, notice) => {
    pubSubService.broadcastToUser(notice.userId, { type: 'automate.quota-exhausted', ...notice })

    if (starter.action.type !== 'channel-event') return
    const channelId = starter.action.channelId
    const resetHuman = notice.resetsAt.slice(11, 16)
    const message: Message = {
      messageId: channelManager.createMessageId(),
      channelId,
      role: 'assistant',
      agentId: starter.action.agentId,
      content: {
        type: 'error',
        errorType: 'upgrade_required',
        userMessage:
          `"${notice.starterName}" was skipped: the ${notice.limit} Automate runs a day of the ` +
          `${notice.planName} plan are used up. The budget resets at ${resetHuman} UTC.`,
        technicalMessage: `${AUTOMATE_QUOTA_REASON}: ${notice.used}/${notice.limit} (starter ${notice.starterId})`,
        context: {
          reason: 'automate_quota',
          used: notice.used,
          limit: notice.limit,
          planId: notice.planId,
          planName: notice.planName,
          resetsAt: notice.resetsAt,
          starterId: notice.starterId,
          starterName: notice.starterName,
          topStarters: notice.topStarters,
        },
      },
      timestamp: new Date().toISOString(),
    }
    await channelManager.saveMessage(message)
    pubSubService.broadcastToTopic(`channel:${channelId}`, { type: 'message', channelId, message })
  })
  automateRunner.setCanExecute(async (starter) => {
    const agentId = (starter.action as { agentId?: string }).agentId
    if (agentId) {
      try {
        await providerService.resolveProviderForAgent(agentId, undefined, starter.createdBy)
      } catch (gateErr) {
        if (
          gateErr instanceof UpgradeRequiredError ||
          gateErr instanceof HoursExhaustedError ||
          gateErr instanceof PaymentDueError
        ) {
          return { allowed: false, reason: `billing-${gateErr.code}` }
        }
        console.warn('[Automate] billing pre-check error (allowing):', gateErr instanceof Error ? gateErr.message : gateErr)
      }
    }
    return automateQuota.check(starter)
  })
  // Live feed for the Automate window: after every run (or refusal) of a
  // starter, its creator's sessions get the fresh daily budget plus a short
  // description of the run, so the quota strip, the list stats and the open
  // run history update without polling. One countDocuments per execution.
  automateRunner.setOnExecutionRecorded(async (starter, result, ctx) => {
    if (!starter.createdBy) return
    const status = await automateQuota.getStatus(starter.createdBy)
    const topStarters = status.exhausted ? await automateQuota.topStartersToday(starter.createdBy) : []
    pubSubService.broadcastToUser(starter.createdBy, {
      type: 'automate.quota-updated',
      ...status,
      topStarters,
      execution: {
        starterId: starter.starterId,
        workspaceId: starter.workspaceId,
        source: ctx.source,
        ok: result.ok,
        refused: result.refused === true,
        error: result.error,
        at: new Date().toISOString(),
      },
    })
  })
  automateRunner.start()

  const listenCallback = () => {
    console.log(
      `Server listening on port ${config.server.port}` +
        (config.server.bindHost ? ` (bound to ${config.server.bindHost})` : ''),
    )
    console.log(`  WebSocket: ws://localhost:${config.server.port}/ws`)
    console.log(`  Health: http://localhost:${config.server.port}/health`)
    if (secretsManager.hasSystem('admin')) {
      console.log(`  Admin: http://localhost:${config.server.port}/admin/*`)
    }
    // Señala readiness a PM2 (wait_ready) ahora que el server acepta conexiones;
    // sin esto PM2 agota listen_timeout (10s) en cada restart. (TER-418)
    notifyProcessManagerReady()
  }

  // BIND_HOST unset (default) binds all interfaces — required so MCA
  // containers reach the core via `host.docker.internal`. Only pass a host
  // arg when BIND_HOST is explicitly set (e.g. 127.0.0.1 for a clone-and-run
  // deployment with no reverse proxy in front).
  //
  // EADDRINUSE SELF-HEAL (incident 2026-11-01 08:40): when an orphan from a
  // previous restart still holds the port, listen() used to throw an
  // uncaught EADDRINUSE and pm2 crash-looped the process SILENTLY — the old
  // orphan kept serving stale code while "the backend" looked restarted.
  // Now: on EADDRINUSE we audit the port, kill every NON-pm2 listener
  // (orphans — SIGTERM, then SIGKILL after 3s; the pm2 tree is never
  // touched), and retry the listen a few times. If the holder is legit pm2
  // (a sibling instance), we exit(1) loudly instead of looping forever.
  const EADDRINUSE_MAX_RETRIES = 3
  let eaddrInUseRetries = 0

  const listenWithSelfHeal = (): void => {
    const onListenError = async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EADDRINUSE') {
        // Any other listen error is fatal — crash loudly, pm2 will restart.
        console.error('❌ Fatal listen error:', error)
        process.exit(1)
      }

      eaddrInUseRetries += 1
      console.error(
        `❌ EADDRINUSE on :${config.server.port} (attempt ${eaddrInUseRetries}/${EADDRINUSE_MAX_RETRIES}) — auditing port ownership...`,
      )

      if (eaddrInUseRetries > EADDRINUSE_MAX_RETRIES) {
        console.error(
          `❌ EADDRINUSE persists after ${EADDRINUSE_MAX_RETRIES} self-heal attempts — giving up loudly. ` +
            `The port is held by something we could not clear. Investigate manually: ss -tlnp | grep ${config.server.port}`,
        )
        process.exit(1)
      }

      try {
        const { killed, ownership } = await killForeignPortHolders({
          port: config.server.port,
          appName: process.env.name || 'teros-backend',
        })
        if (killed.length > 0) {
          console.error(
            `🔪 EADDRINUSE self-heal: killed foreign listener(s) on :${config.server.port}: ${killed.join(', ')} — retrying listen`,
          )
        } else {
          console.error(
            `⚠️  EADDRINUSE but no foreign listener found (audit: ${ownership.reason}) — ` +
              `the holder looks like a legit pm2 process. Waiting 2s before retry...`,
          )
        }
      } catch (auditError) {
        console.error('⚠️  EADDRINUSE self-heal audit failed:', auditError)
      }

      // Brief pause so a SIGTERMed orphan can actually release the socket.
      setTimeout(() => {
        httpServer.removeListener('error', onListenError)
        listenWithSelfHeal()
      }, 2000)
    }

    httpServer.once('error', onListenError)
    if (config.server.bindHost) {
      httpServer.listen(config.server.port, config.server.bindHost, listenCallback)
    } else {
      httpServer.listen(config.server.port, listenCallback)
    }
  }

  listenWithSelfHeal()

  // -------------------------------------------------------------------------
  // MCA BOOT SYNC (background, non-blocking)
  // -------------------------------------------------------------------------

  if (config.mca.basePath) {
    const mcasDir = resolve(config.mca.basePath)
    runMcaBootSync(db, mcasDir, mcaService, mcaManager)
    console.log('🔄 MCA boot sync scheduled (background)')
  }

  // -------------------------------------------------------------------------
  // ONE-TIME BACKFILL: core default apps for agents remapped by the
  // consolidate-agent-cores migration (TER-385). The migration only re-points
  // `coreId`, so super-agents never received their core's defaultApps
  // (mca.teros.core). This provisions them via the SAME path as agent creation,
  // making migrated and freshly-created agents identical. Runs in the background
  // (mirrors MCA boot sync) so it never delays server start; the lazy
  // getAgentApps path covers any agent used before it finishes. Guarded by a
  // marker so it runs only once (single-instance prod — no leader lock needed).
  // -------------------------------------------------------------------------

  const BACKFILL_CORE_APPS = 'agent-core-apps-20260529'
  const backfillsCol = db.collection<BackfillMarker>('system_backfills')
  // Fire-and-forget: the runner guards itself with the marker and only marks
  // complete on a fully-clean run (a partial/failed run is retried next boot).
  void runCoreAppsBackfillOnce(backfillsCol, provisioningService, BACKFILL_CORE_APPS).catch((err) =>
    console.error('❌ Backfill agent-core-apps failed (will retry next boot):', err),
  )
  console.log('🔄 Backfill agent-core-apps scheduled (background, one-time)')

  // -------------------------------------------------------------------------
  // RESUME SERVICE
  // -------------------------------------------------------------------------

  // Recovery is system_resume-only: interrupted user messages are already in
  // the channel history, and the resume event tells the agent to read it.
  // Boot-time replay of queued messages was removed after the 2026-08-14
  // incident (every restart re-drove the channel's stale backlog).
  // Liveness registration (DEP-REQ-6): lets the resume sweep below wait for the
  // previous color of a blue/green handoff to exit before touching channels.
  const instanceRegistry = new InstanceRegistry(container.get(Tokens.LeaderElectionService))
  instanceRegistry
    .start()
    .catch((error) => console.error('[instances] registration failed:', error))

  ResumeService.startWithDelay(
    db,
    eventHandler,
    channelManager,
    autoplayService,
    sessionStore,
    instanceRegistry,
  )
    .then(() => console.log('🔄 Resume service initialized'))
    .catch((error) => console.error('🔄 Resume service failed:', error))

  // -------------------------------------------------------------------------
  // AGENT USAGE INSTRUMENTATION
  // -------------------------------------------------------------------------
  // - Buffer (UsageEventBuffer) starts its periodic flush timer.
  // - Reconciler closes orphan sessions / tool executions every 5 min.
  // - Rollup job recomputes missing hour buckets every 5 min (catch-up).
  //
  // Feature flag AGENT_USAGE_BACKGROUND_JOBS_ENABLED (default 'true') gates
  // the background timers. The buffer always starts so emit() ordered by
  // handlers does not silently accumulate without flushing on the rare case
  // of misconfiguration.

  const usageEventBuffer = container.get(Tokens.UsageEventBuffer)
  usageEventBuffer.start()
  console.log('📈 Agent usage event buffer started')

  const agentUsageReconciler = container.get(Tokens.AgentUsageReconciler)
  const agentUsageRollupJob = container.get(Tokens.AgentUsageRollupJob)

  const agentHoursTracker = container.get(Tokens.AgentHoursTracker)
  const billingResetCron = container.get(Tokens.BillingResetCron)
  const billingReconciliationCron = container.get(Tokens.BillingReconciliationCron)
  const billingChargeCron = container.get(Tokens.BillingChargeCron)

  const backgroundJobsEnabled =
    (process.env.AGENT_USAGE_BACKGROUND_JOBS_ENABLED ?? 'true') !== 'false'
  if (backgroundJobsEnabled) {
    agentUsageReconciler.start()
    agentUsageRollupJob.start()
    agentHoursTracker.start()
    billingResetCron.start()
    billingReconciliationCron.start()
    billingChargeCron.start() // no-op when Stripe is not configured
    console.log(
      '📈 Agent usage background jobs started (reconciler + rollup + tracker + reset + reconciliation + charge)',
    )
  } else {
    console.log('📈 Agent usage background jobs DISABLED via env')
  }

  // Sentry alarm bridge: polls buffer/reconciler/rollup metrics and emits
  // Sentry events when thresholds are crossed. Time-series go to /metrics.
  //
  // The bridge is gated behind the leader lock — only ONE instance emits
  // Sentry events for a given incident, so the inbox does not flood with
  // N duplicate alerts when running multi-instance. Per-instance counters
  // remain visible via /metrics with the `instance` label.
  const agentUsageSentryAlerts = new AgentUsageSentryAlerts(
    usageEventBuffer,
    agentUsageReconciler,
    agentUsageRollupJob,
    container.get(Tokens.LeaderElectionService),
    db, // read handle for the model-health alarms (TER-616/R5)
    container.get(Tokens.LatitudeExportMetrics), // F3a export alarms
  )
  agentUsageSentryAlerts.start()

  // -------------------------------------------------------------------------
  // GRACEFUL SHUTDOWN
  // -------------------------------------------------------------------------

  const gracefulShutdown = async (signal: string) => {
    console.log(`\n${signal} received - shutting down gracefully...`)

    // ORPHAN GUARD (incident 2026-11-01 08:40): pm2 runs the tsx wrapper; tsx
    // spawns this server as a child and forwards SIGTERM. If shutdown does
    // not finish within PM2's kill_timeout (30s in ecosystem.config.cjs), pm2
    // SIGKILLs the WRAPPER only — this child survives, re-parented to init,
    // still holding the listen socket and serving STALE code while the new
    // pm2 process crash-loops on EADDRINUSE. This watchdog force-exits at
    // 25s (5s before pm2's SIGKILL) so the port is ALWAYS released by us,
    // deterministically, before pm2 can create an orphan.
    const SHUTDOWN_WATCHDOG_MS = 25_000
    let watchdogFired = false
    const shutdownWatchdog = setTimeout(() => {
      watchdogFired = true
      console.error(
        `⏱️  Shutdown watchdog fired after ${SHUTDOWN_WATCHDOG_MS}ms — forcing exit before pm2's kill_timeout creates an orphan`,
      )
      process.exit(1)
    }, SHUTDOWN_WATCHDOG_MS)
    // Never keep the event loop alive just for the watchdog.
    shutdownWatchdog.unref?.()

    automateRunner.stop()

    // Stop the background jobs first; then flush pending usage events before
    // closing the DB so we don't lose the tail of the queue.
    agentUsageSentryAlerts.stop()
    agentUsageRollupJob.stop()
    agentUsageReconciler.stop()
    // Billing crons: drain in parallel — stop scheduling, wait for any in-flight
    // tick to finish (so we never tear down Mongo mid-write), and release the
    // leader lock for fast failover. Bounded so we still fit PM2's kill_timeout.
    const DRAIN_TIMEOUT_MS = 8000
    const drained = await Promise.all([
      agentHoursTracker.drain(DRAIN_TIMEOUT_MS),
      billingResetCron.drain(DRAIN_TIMEOUT_MS),
      billingReconciliationCron.drain(DRAIN_TIMEOUT_MS),
      billingChargeCron.drain(DRAIN_TIMEOUT_MS),
    ])
    if (drained.some((ok) => !ok)) {
      console.warn('⏳ Some billing crons did not drain before timeout — forcing shutdown')
    }
    try {
      // Bounded flush: within 10s the buffer either persists to Mongo or drains
      // the tail to the dead-letter — the "Mongo OR dead-letter" guarantee must
      // complete before PM2's kill_timeout (A1.9).
      await usageEventBuffer.shutdown({ timeoutMs: 10_000 })
    } catch (error) {
      console.error('📈 Usage buffer shutdown failed:', error)
    }

    // F3a — flush + shut down the Latitude export AFTER the usage buffer (so the
    // tail of session.ended has fired its exports) and BEFORE Mongo closes (the
    // build path still queries Mongo). Best-effort; a crash before this drops the
    // in-flight batch (declared loss window).
    const sessionTraceExporter = container.get(Tokens.SessionTraceExporter)
    if (sessionTraceExporter) {
      try {
        await sessionTraceExporter.shutdown()
      } catch (error) {
        console.error('📈 Latitude export shutdown failed:', error)
      }
    }

    // F4·C0 — drain in-flight score emits (bounded; deferred chains past the
    // deadline are the declared best-effort loss window).
    const latitudeScoreEmitter = container.get(Tokens.LatitudeScoreEmitter)
    if (latitudeScoreEmitter) {
      try {
        await latitudeScoreEmitter.shutdown()
      } catch (error) {
        console.error('📈 Latitude score emitter shutdown failed:', error)
      }
    }

    voiceHandler.cleanupAll()
    voiceLoop.cleanupAll()

    // Close the HTTP server FIRST so it stops accepting new connections
    // (including WebSocket upgrade requests). Without this, there is a window
    // where the HTTP server is still live but the WS servers below are already
    // gone — any upgrade request in that gap gets a connection reset.
    httpServer.close()

    // Close existing client WebSocket connections gracefully, then shut down
    // the main WS server.
    // 1012 = Service Restart: the client treats it as "reconnect now" (jittered,
    // no backoff, no attempt consumed) instead of the exponential backoff a
    // network drop gets. With a blue/green handoff the other color is already
    // serving, so the reconnect lands immediately (DEP-REQ-5).
    wss.clients.forEach((client) => client.close(1012, 'server-restart'))
    wss.close()

    // Terminal viewers reconnect on their own; terminal hosts (tmux) are left
    // running on purpose — sessions survive the restart.
    await terminalStream.close()
    await streamRelay?.shutdown()

    // Now shut down the MCA WebSocket server and kill MCA containers.
    if (remoteDeviceGateway) {
      await remoteDeviceGateway.close()
    }
    if (mcaConnectionManager) {
      await mcaConnectionManager.shutdown()
    }
    if (mcaManager) {
      await mcaManager.shutdown()
    }

    await container.dispose()

    // Deregister LAST (DEP-REQ-6): until here this process may still be
    // finishing work the next color must not resume on top of.
    await instanceRegistry.stop()
    await mongoClient.close()

    // Shutdown finished in time — cancel the orphan-guard watchdog.
    clearTimeout(shutdownWatchdog)
    if (watchdogFired) {
      console.warn('⚠️  Shutdown completed after the watchdog fired — exiting immediately')
    }
    console.log('Goodbye!')
    process.exit(0)
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
}
