/**
 * Server Bootstrap
 *
 * Full server initialisation logic extracted from index.ts main().
 * Call bootstrapServer() from index.ts after secrets/DB are ready.
 */

import { createServer } from 'http'
import { resolve } from 'path'
import type { Db, MongoClient } from 'mongodb'
import { WebSocketServer } from 'ws'
import { config } from '../config'
import { type Container, Tokens } from '../container'
import { initAuthService } from '../auth/auth-service'
import { AgentProvisioningService } from '../services/agent-provisioning-service'
import { initGoogleAuth } from '../auth/google-auth'
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
import { WebSocketHandler } from '../handlers/websocket-handler'
import { FeedbackService } from '../services/feedback-service'
import { createAdminRoutes } from '../routes/admin-routes'
import { createBoardRoutes } from '../routes/board-routes'
import { createMcaCallbackRoutes } from '../routes/mca-callback-routes'
import { createProviderOAuthRoutes } from '../routes/provider-oauth-routes'
import { createG2Routes } from '../routes/g2-routes'
import { McaConnectionManager } from '../services/mca-connection-manager'
import { ResumeService } from '../services/resume-service'
import { SchedulerService } from '../services/scheduler-service'
import { UpgradeRequiredError, HoursExhaustedError, PaymentDueError } from '../services/billing-gate'
import { getEmailService, isEmailConfigured } from '../services/email-service'
import { runMcaBootSync } from '../services/mca-boot-sync'
import { runMigrations } from '../migrations/runner'
import { createHttpHandler } from './http-server'
import { registerDependencies } from './container-setup'
import { notifyProcessManagerReady } from './process-manager'
import { type BackfillMarker, runCoreAppsBackfillOnce } from './core-apps-backfill'
import { AgentUsageSentryAlerts } from '../services/agent-usage-sentry-alerts'
import { createMetricsRoute } from '../routes/metrics-routes'
import { ensureBillingIndexes, seedBillingPlans, seedDefaultTerosProviderConfig } from '../models/billing'

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

  if (isEmailConfigured()) {
    getEmailService(db)
    await getEmailService().ensureIndexes()
  }

  // -------------------------------------------------------------------------
  // EMAIL SERVICE
  // -------------------------------------------------------------------------

  if (isEmailConfigured(secretsManager)) {
    getEmailService(db)
    await getEmailService().ensureIndexes()
  }

  // -------------------------------------------------------------------------
  // AUTH SERVICES
  // -------------------------------------------------------------------------

  const authService = initAuthService(db)
  await authService.ensureIndexes()
  console.log('AuthService initialized')

  // Google OAuth (optional)
  const oauthSecrets = secretsManager.system('oauth')
  if (oauthSecrets?.google?.clientId && oauthSecrets?.google?.clientSecret) {
    const googleAuth = initGoogleAuth(db, {
      clientId: oauthSecrets.google.clientId,
      clientSecret: oauthSecrets.google.clientSecret,
      redirectUri:
        oauthSecrets.google.redirectUri ||
        `http://localhost:${config.server.port}/auth/google/callback`,
    })
    await googleAuth.ensureIndexes()
    console.log('Google OAuth initialized')
  } else {
    console.log('Google OAuth: not configured')
  }

  await mcaOAuth.ensureIndexes()
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

  // Connect WorkspaceService to AuthService/UserService (late binding to avoid circular deps)
  authService.setWorkspaceService(workspaceService)

  // Connect AgentProvisioningService to AuthService (late binding — provisioning
  // depends on McaService, which is built after AuthService).
  const provisioningService = new AgentProvisioningService(container.get(Tokens.Db), mcaService)
  authService.setProvisioningService(provisioningService)

  // Connect ProviderService to AuthService/UserService so new-user creation can
  // provision the default Teros provider (late binding — same DI shape as above).
  authService.setProviderService(providerService)

  // Ensure indexes
  await channelManager.ensureIndexes()
  await mcaService.ensureIndexes()
  await workspaceService.ensureIndexes()

  // -------------------------------------------------------------------------
  // PUBSUB + EVENT WIRING
  // -------------------------------------------------------------------------

  const pubSubService = container.get(Tokens.PubSubService)
  await pubSubService.init()

  const feedbackService = new FeedbackService(db, pubSubService)
  await feedbackService.ensureIndexes()
  console.log('FeedbackService initialized')

  pubSubService.setEventHandler(eventHandler.handleScheduledEvent.bind(eventHandler))
  pubSubService.setSessionManager(sessionManager)
  pubSubService.setWorkspaceService(workspaceService)
  sessionManager.setPubSubService(pubSubService)
  eventHandler.setPubSubService(pubSubService)

  const ptyManager = container.get(Tokens.PtyManager)

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
  // Si un evento de scheduler incluye userId en el payload, el subscription
  // service compara con channel.userId antes de inyectar el wake-up.
  mcaEventSubscriptionService.setGetChannelOwnerUserIdFn(async (channelId) => {
    const channel = await channelManager.getChannel(channelId as any)
    return channel?.userId ?? null
  })
  // Note: setInjectTextAndWakeFn is wired after wsHandler is created

  const boardSubscriptionService = container.get(Tokens.BoardSubscriptionService)
  await boardSubscriptionService.ensureIndexes()
  boardSubscriptionService.setEventInjector(
    eventHandler.handleScheduledEvent.bind(eventHandler),
  )

  const boardService = container.get(Tokens.BoardService)
  await boardService.ensureIndexes()

  const featureFlagService = container.get(Tokens.FeatureFlagService)
  await featureFlagService.ensureIndexes()
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
  await autoplayService.ensureIndexes()

  // F4·C1 — signal-index + webhook-dedupe collections (unique keys + TTL).
  await container.get(Tokens.LatitudeSignalIndex).ensureIndexes()

  // -------------------------------------------------------------------------
  // BILLING — plans + subscriptions indexes & seed
  // -------------------------------------------------------------------------
  await ensureBillingIndexes(db)
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
    const mcaBasePath = resolve(config.mca.basePath!)
    console.log(`MCA Manager initialized (base path: ${mcaBasePath})`)
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
  const httpUploadHandler = new HttpUploadHandler(db, authService)
  const httpMediaHandler = new HttpMediaHandler(authService, mcaManager?.getContainerManager())
  const httpFileHandler = new HttpFileHandler(db, authService, volumeService, workspaceService, channelManager)
  const httpShareHandler = new HttpShareHandler(
    db,
    authService,
    volumeService,
    workspaceService,
    shareService,
  )

  const adminRoutes = createAdminRoutes({ db, secretsManager })
  const boardRoutes = createBoardRoutes({ boardService, workspaceService, sessionManager })
  const mcaCallbackRoutes = createMcaCallbackRoutes({
    db,
    secretsManager,
    authManager,
    workspaceService,
    volumeService,
    provisioningService,
    // Singleton del contenedor: WebSocketHandler le wirea setOnToolCacheInvalidate,
    // así el auto-grant de install-app refresca las tools de conversaciones activas.
    mcaService,
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
  })
  const providerOAuthRoutes = createProviderOAuthRoutes({ db, providerService })

  // G2 routes — lazy wakeUpCallback (wsHandler created after httpHandler)
  let wsHandlerRef: WebSocketHandler | null = null
  const g2Routes = createG2Routes({
    db,
    channelManager,
    authService,
    providerService,
    getWakeUpCallback: () => {
      if (!wsHandlerRef) throw new Error('[G2] wsHandler not yet initialized')
      return wsHandlerRef.getAgentWakeUpCallback()
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

  // Mongo-backed rate limiter — shared by the HTTP edge and the /ws handshake.
  // Null (disabled) only when RATE_LIMIT_ENABLED=false.
  const rateLimiter = config.security.rateLimit.enabled
    ? new RateLimiter(db, createLogger('RateLimiter'))
    : null

  const httpHandler = createHttpHandler({
    adminRoutes,
    boardRoutes,
    mcaCallbackRoutes,
    providerOAuthRoutes,
    g2Routes,
    metricsRoute,
    authHandler: httpAuthHandler,
    mcaAuthHandler: httpMcaAuthHandler,
    githubWebhookHandler,
    latitudeWebhookHandler,
    appWebhookHandler,
    stripeWebhookHandler,
    uploadHandler: httpUploadHandler,
    mediaHandler: httpMediaHandler,
    fileHandler: httpFileHandler,
    shareHandler: httpShareHandler,
    eventHandler,
    mcaEventSubscriptionService,
    sessionManager,
    mcaManager,
    rateLimiter: rateLimiter ?? undefined,
    db,
  })

  const httpServer = createServer(httpHandler)

  // -------------------------------------------------------------------------
  // WEBSOCKET SERVER
  // -------------------------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true })
  console.log('WebSocket server created (noServer mode)')

  const wsHandler = new WebSocketHandler(wss, sessionManager, channelManager, db, sessionStore, {
    clock: container.get(Tokens.Clock),
    secretsManager,
    mcaManager,
    mcaOAuth,
    authManager,
    workspaceService,
    volumeService,
    boardService,
    autoplayService,
    eventHandler,
    pubSubService,
    mcaEventSubscriptionService,
    boardSubscriptionService,
    ptyManager,
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
  })

  wsHandlerRef = wsHandler

  eventHandler.setAgentWakeUpCallback(wsHandler.getAgentWakeUpCallback())
  autoplayService.setWakeUpCallback(wsHandler.getAgentWakeUpCallback())
  // Notify the supervising channel when a stuck task is auto-blocked (TER-650/G2).
  autoplayService.setEventHandler(eventHandler)
  autoplayService.startPeriodicScheduler()

  mcaEventSubscriptionService.setInjectTextAndWakeFn(async ({ channelId, text, senderAgentId }) => {
    const wakeUpCallback = wsHandler.getAgentWakeUpCallback()
    await wakeUpCallback(channelId, senderAgentId ?? 'system', text)
  })

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
  )
  voiceHandler.setPubSubService(pubSubService)
  voiceHandler.setSessionStore(sessionStore)
  // Wire VoiceHandler → MessageHandler so the text engine can check whether
  // a voice session is active before processing a text message. This prevents
  // duplicate responses when voice mode is active (ElevenLabs + text engine)
  // and unwanted responses in silent mode.
  wsHandler.getMessageHandler().setVoiceHandler(voiceHandler)
  console.log('VoiceHandler initialized')

  // -------------------------------------------------------------------------
  // MCA CONNECTION MANAGER
  // -------------------------------------------------------------------------

  let mcaConnectionManager: McaConnectionManager | undefined
  if (mcaManager) {
    const wsTokenExpiryMs = process.env.CONTAINER_PROVIDER === 'kubernetes' ? 120000 : 30000
    mcaConnectionManager = new McaConnectionManager(db, {
      secretsManager,
      authManager,
      channelManager,
      boardService,
      sessionManager,
      wsRouter: wsHandler.getWsRouter(),
      pubSubService,
      mcaEventSubscriptionService,
      workspaceService,
      volumeService,
      tokenExpiryMs: wsTokenExpiryMs,
    })
    mcaConnectionManager.initWebSocketServer(httpServer)
    await mcaConnectionManager.ensureIndexes()
    mcaManager.setConnectionManager(mcaConnectionManager)
    mcaOAuth.setConnectionManager(mcaConnectionManager)

    mcaConnectionManager.on('mca:event', async (event) => {
      console.log(`[Main] MCA event received: topic=${event.topic ?? event.eventType} from ${event.appId}`)
      const topic = event.topic ?? event.eventType ?? 'unknown'
      const { appId, topic: _t, eventType: _e, ...payload } = event
      await mcaEventSubscriptionService.dispatch({ topic, payload: { appId, ...payload } })
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
      const agentId = url.searchParams.get('agentId')
      const existingChannelId = url.searchParams.get('channelId') || undefined
      const chatChannelId = url.searchParams.get('chatChannelId') || undefined

      if (!sessionId || !agentId) {
        console.warn('[WebSocket] Voice connection missing sessionId or agentId')
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        socket.destroy()
        return
      }

      // Feature flag guard: voice.enabled must be true for this user
      // We need to validate the session and check the flag before upgrading
      ;(async () => {
        try {
          const authResult = await authService.validateSession(sessionId)
          if (!authResult.success || !authResult.user) {
            console.warn('[WebSocket] Voice connection: invalid session')
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
            socket.destroy()
            return
          }

          // Resolve user's workspace context for feature flag evaluation
          const userWorkspaces = await workspaceService.listUserWorkspaces(authResult.user.userId)
          const workspaceId = userWorkspaces[0]?.workspaceId

          const isVoiceEnabled = await featureFlagService.resolve('voice.enabled', {
            userId: authResult.user.userId,
            workspaceId,
          })

          if (!isVoiceEnabled) {
            console.warn(
              `[WebSocket] Voice connection rejected: voice.enabled=false for user ${authResult.user.userId}`,
            )
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
            socket.destroy()
            return
          }

          // Flag is enabled — proceed with the WebSocket upgrade
          const wssVoice = new WebSocketServer({ noServer: true })
          wssVoice.handleUpgrade(request, socket, head, (ws) => {
            voiceHandler
              .handleConnection(ws, sessionId, agentId, existingChannelId, chatChannelId)
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
    } else {
      console.warn(`[WebSocket] Unknown upgrade path: ${pathname}`)
      socket.destroy()
    }
  })

  // -------------------------------------------------------------------------
  // SCHEDULER SERVICE
  // -------------------------------------------------------------------------

  let schedulerService: SchedulerService | undefined
  try {
    schedulerService = container.get(Tokens.SchedulerService)
    schedulerService.setMCAEventSubscriptionService(mcaEventSubscriptionService)
    // Capa 3 (TER-358): pre-dispatch ownership check — el executor verifica
    // que `channel.userId === reminder.user_id` antes de cada dispatch.
    schedulerService.bindChannelManager(channelManager)
    // Billing hard gate (UX): before dispatching a scheduled turn, check the
    // channel's agent can consume Teros. Fail-open on unexpected errors — the
    // structural gate in ProviderService still protects cost at dispatch.
    schedulerService.setCanDispatchToChannelFn(async (channelId) => {
      try {
        const channel = await channelManager.getChannel(channelId as any)
        if (!channel?.agentId) return { allowed: true }
        // Gate the channel actor's hours (billing charges them), not the owner's
        // (TER-650/G6).
        await providerService.resolveProviderForAgent(channel.agentId, undefined, channel.userId)
        return { allowed: true }
      } catch (gateErr) {
        if (
          gateErr instanceof UpgradeRequiredError ||
          gateErr instanceof HoursExhaustedError ||
          gateErr instanceof PaymentDueError
        ) {
          return { allowed: false, reason: `billing-${gateErr.code}` }
        }
        console.warn(
          '[Scheduler] billing pre-check error (allowing):',
          gateErr instanceof Error ? gateErr.message : gateErr,
        )
        return { allowed: true }
      }
    })
    // Leader gating: en multi-instancia solo el líder ejecuta el tick. En
    // single-instance esta instancia siempre gana el lock (no cambia nada).
    schedulerService.setLeaderElection(container.get(Tokens.LeaderElectionService))
    schedulerService.start()
    const stats = await schedulerService.getStats()
    console.log(
      `📅 Scheduler: ${stats.pendingReminders} pending reminders, ${stats.enabledTasks} recurring tasks`,
    )
  } catch (error) {
    console.error(
      '📅 Scheduler service failed to start:',
      error instanceof Error ? error.message : error,
    )
  }

  // -------------------------------------------------------------------------
  // PRIVATE CHANNELS CLEANUP JOB
  // -------------------------------------------------------------------------

  const privateChannelCleanupInterval = setInterval(
    async () => {
      try {
        const deletedCount = await channelManager.cleanupExpiredPrivateChannels()
        if (deletedCount > 0) {
          console.log(`🧹 Private channels cleanup: ${deletedCount} expired channels deleted`)
        }
      } catch (error) {
        console.error('🧹 Private channels cleanup failed:', error)
      }
    },
    60 * 60 * 1000,
  )

  setTimeout(async () => {
    try {
      await channelManager.cleanupExpiredPrivateChannels()
    } catch (error) {
      console.error('🧹 Initial private channels cleanup failed:', error)
    }
  }, 10000)

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

  await runMigrations(db)

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
  if (config.server.bindHost) {
    httpServer.listen(config.server.port, config.server.bindHost, listenCallback)
  } else {
    httpServer.listen(config.server.port, listenCallback)
  }

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

  // Phase D — TER-319: wire the queue-replay hook so user messages left
  // `pending`/`running` in the worker FIFO at crash time get re-driven
  // through the regular agent pipeline (resolves the original TER-319 bug
  // "user messages silently dropped" across backend restarts too, not
  // just within a single live process).
  const messageHandlerForResume = wsHandler.getMessageHandler()
  ResumeService.startWithDelay(
    db,
    eventHandler,
    channelManager,
    autoplayService,
    sessionStore,
    async (channelId, _messageId, text, parts) => {
      const channel = await channelManager.getChannel(channelId)
      if (!channel?.agentId) {
        console.warn(`🔄 ResumeService: replay skipped — channel ${channelId} has no agentId`)
        return
      }
      // Reconstruct file descriptors for any FilePart present in the queued
      // message so the agent sees file-only or mixed-content messages on
      // replay (otherwise pure-file uploads were silently dropped at boot).
      const fileDescriptors: string[] = []
      for (const p of parts) {
        if (p.type !== 'file') continue
        const filename = p.filename || 'file'
        const isImage = (p.mime || '').startsWith('image/')
        fileDescriptors.push(
          isImage
            ? `[User sent an image: ${filename}](${p.url})`
            : `[User sent a file: ${filename} (${p.mime || 'application/octet-stream'})](${p.url})`,
        )
      }
      const messageForAgent = fileDescriptors.length === 0
        ? text
        : text
          ? `${text}\n\n${fileDescriptors.join('\n')}`
          : fileDescriptors.join('\n')
      await messageHandlerForResume.processAgentResponse(channelId, channel.agentId, messageForAgent)
    },
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

    schedulerService?.stop()
    clearInterval(privateChannelCleanupInterval)

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

    if (mcaConnectionManager) {
      await mcaConnectionManager.shutdown()
    }
    if (mcaManager) {
      await mcaManager.shutdown()
    }

    wss.clients.forEach((client) => client.close())
    wss.close()
    httpServer.close()

    await container.dispose()
    await mongoClient.close()

    console.log('Goodbye!')
    process.exit(0)
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
}
