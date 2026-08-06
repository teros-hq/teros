/**
 * WebSocket Handler
 * Handles WebSocket connections and message routing
 */

import type { Clock, ILLMClient, SessionStore } from "@teros/core"
import type { AuthMessage, ClientMessage, ServerMessage } from "@teros/shared"
import { isClientMessage, isWsRequest, normalizeError, parseClientMessage } from "@teros/shared"
import type { Db } from "mongodb"
import type { IncomingMessage } from "http"
import type { RawData, WebSocket, WebSocketServer } from "ws"
import type { AuthManager } from "../auth/auth-manager"
import type { IdentityService } from "../auth/identity-service"
import type { SessionService } from "../auth/session-service"
import type { McaOAuth } from "../auth/mca-oauth"
import { captureException, runWithRequestContext } from "../lib/sentry"
import { getWsLogger, jsonBytes } from "../lib/ws-logger"
import { createLogger } from "../lib/logger"
import type { SecretsManager } from "../secrets/secrets-manager"
import type { BoardService } from "../services/board-service"
import type { BoardSubscriptionService } from "../services/board-subscription-service"
import type { AutoplayService } from "../services/autoplay-service"
import type { DesktopStateService } from "../services/desktop-state-service"
import type { ProjectService } from "../services/project-service"
import type { SkillService } from "../services/skill-service"
import type { ChannelManager } from "../services/channel-manager"
import { FeedbackService } from "../services/feedback-service"
import type { McaManager } from "../services/mca-manager"
import { McaService } from "../services/mca-service"
import { ModelService } from "../services/model-service"
import { ProviderService } from "../services/provider-service"
import type { SessionManager } from "../services/session-manager"
import type { VolumeService } from "../services/volume-service"
import type { WorkspaceService } from "../services/workspace-service"
import { ShareService } from "../services/share-service"
import { loggingMiddleware, WsRouter } from "../ws-framework"

import { UserService } from "../auth/user-service"
import { AuthHandler } from "./auth-handler"
import { register as registerAdminDomain } from "./domains/admin"
import { register as registerAdminApiDomain } from "./domains/admin-api"
import { register as registerBillingDomain } from "./domains/billing"
import { register as registerAgentDomain } from "./domains/agent"
import { register as registerAppDomain } from "./domains/app"
import { register as registerBoardDomain } from "./domains/board"
import { register as registerChannelDomain } from "./domains/channel"
import { register as registerSchedulerDomain } from "./domains/scheduler"
import {
  cleanupWatcherRegistry,
  createWatcherRegistry,
  register as registerFileWatcherDomain,
  type WatcherRegistry,
} from "./domains/file-watcher"
import { register as registerProfileDomain } from "./domains/profile"
import { register as registerProviderDomain } from "./domains/provider"
import { register as registerWorkspaceDomain } from "./domains/workspace"
import { register as registerFsBrowserDomain } from "./domains/fs-browser"
import { register as registerFeedbackDomain } from "./domains/feedback"
import { register as registerFileShareDomain } from "./domains/file-share"
import { register as registerSkillDomain } from "./domains/skill"
import { register as registerProjectDomain } from "./domains/project"
import { register as registerDesktopStateDomain } from "./domains/desktop-state"
import { register as registerTerminalDomain } from "./domains/terminal"
import { register as registerFeatureFlagDomain } from "./domains/feature-flag"
import { register as registerSubscriptionsDomain } from "./domains/subscriptions"
import type { AgentWakeUpCallback, EventHandler } from "./event-handler"
import { MessageHandler } from "./message-handler"
import type { PubSubService } from "../services/pubsub-service"
import type { MCAEventSubscriptionService } from "../services/mca-event-subscription-service"
import type { LatitudeScoreEmitter } from "../services/latitude-score-emitter"
import type { PtyManager } from "../services/pty-manager"

const log = createLogger('WebSocketHandler')

export interface WebSocketHandlerOptions {
  authHandler?: AuthHandler
  /** Reloj inyectable — determinista (FixedClock) en modo test. TER-563. */
  clock?: Clock
  mcaManager?: McaManager | null
  llmClient?: ILLMClient
  toolExecutor?: any // Mock tool executor for tests
  secretsManager?: SecretsManager
  mcaOAuth?: McaOAuth | null
  authManager?: AuthManager | null
  workspaceService?: WorkspaceService | null
  volumeService?: VolumeService | null
  boardService?: BoardService | null
  boardSubscriptionService?: BoardSubscriptionService | null
  autoplayService?: AutoplayService | null

  eventHandler?: EventHandler | null
  pubSubService?: PubSubService | null
  mcaEventSubscriptionService?: MCAEventSubscriptionService | null
  ptyManager?: PtyManager | null
  /** F4·C0 — Latitude score emitter for the 👎 feedback hook. Null when not wired. */
  latitudeScoreEmitter?: LatitudeScoreEmitter | null

  // Injectable services (avoids manual `new` inside constructor)
  userService?: UserService | null
  identityService?: IdentityService | null
  sessionService?: SessionService | null
  providerService?: ProviderService | null
  modelService?: ModelService | null
  mcaService?: McaService | null
  shareService?: ShareService | null
  skillService?: SkillService | null
  projectService?: ProjectService | null
  desktopStateService?: DesktopStateService | null
  featureFlagService?: import("../services/feature-flag-service").FeatureFlagService | null
  feedbackService?: FeedbackService | null
  stripePaymentService?: import("../services/stripe-payment-service").StripePaymentService | null

  // Agent-usage instrumentation services (forwarded to MessageHandler via setters)
  agentUsageSessionService?: import("../services/agent-usage-session-service").AgentUsageSessionService | null
  toolExecutionService?: import("../services/tool-execution-service").ToolExecutionService | null
  agentUsageHealthDeps?: {
    buffer: import("../services/usage-event-buffer").UsageEventBuffer
    reconciler: import("../services/agent-usage-reconciler").AgentUsageReconciler
    rollup: import("../services/agent-usage-rollup-job").AgentUsageRollupJob
  } | null
  /** F4·C1 return path — decorates the Session Trace with a Latitude signal badge. */
  latitudeSignalIndex?: import("../services/latitude-signal-index").LatitudeSignalIndex | null
  /** F4·C2 — reads Latitude's clustered signals for the admin dashboard. */
  latitudeReadClient?: import("../services/latitude-read-client").LatitudeReadClient | null
}

export class WebSocketHandler {
  private authHandler: AuthHandler
  private messageHandler: MessageHandler
  private mcaService: McaService
  private modelService: ModelService
  private providerService: ProviderService
  private mcaOAuth?: McaOAuth | null
  private userAuthManager?: AuthManager | null

  // Stored for lazy FileWatcherRegistry creation per connection
  private volumeService: VolumeService | null = null
  private workspaceService: WorkspaceService | null = null

  // Health deps for agent-usage status surface (optional)
  private agentUsageHealthDeps: WebSocketHandlerOptions['agentUsageHealthDeps'] | null = null

  // Map WebSocket to sessionId for quick lookup
  private wsToSession: WeakMap<WebSocket, string> = new WeakMap()

  // Map WebSocket to client IP (captured at connection time)
  private wsToIp: WeakMap<WebSocket, string> = new WeakMap()

  // Map WebSocket to the raw auth token (needed by impersonation handlers)
  private wsToToken: WeakMap<WebSocket, string> = new WeakMap()

  // UserService for access control checks
  private userService: UserService

  // New WsRouter — handles framework-migrated actions
  private wsRouter: WsRouter

  // PubSubService — unified pub/sub (replaces SubscriptionManager for file-watcher)
  private pubSubService: PubSubService | null = null

  // FeedbackService — message-level and conversation-level feedback
  private feedbackService: FeedbackService | null = null

  // Per-connection file watcher registry
  private wsToWatcherRegistry: WeakMap<WebSocket, WatcherRegistry> = new WeakMap()

  constructor(
    private wss: WebSocketServer,
    private sessionManager: SessionManager,
    private channelManager: ChannelManager,
    private db: Db,
    sessionStore?: SessionStore,
    options?: WebSocketHandlerOptions,
  ) {
    this.authHandler = options?.authHandler ?? new AuthHandler(sessionManager)
    this.userService = options?.userService ?? new UserService(db)
    this.providerService = options?.providerService ?? new ProviderService(db)
    this.messageHandler = new MessageHandler(
      channelManager,
      sessionManager,
      db,
      sessionStore,
      options?.mcaManager, // Pass shared McaManager instead of basePath
      options?.llmClient,
      options?.toolExecutor,
      options?.secretsManager,
      undefined, // modelService — default
      undefined, // providerService — default
      undefined, // mcaService — default
      undefined, // usageService — default
      undefined, // usageTrackingService — default
      options?.clock, // Clock inyectable — determinista en modo test (TER-563)
    )

    // Wire board service + event handler for automatic task running detection
    if (options?.boardService && options?.eventHandler) {
      this.messageHandler.setTaskServices(options.boardService, options.eventHandler)
    }

    // Wire PubSubService for persistent channel-to-channel subscriptions
    if (options?.pubSubService) {
      this.pubSubService = options.pubSubService
      this.messageHandler.setPubSubService(options.pubSubService)
    }

    // Wire MCAEventSubscriptionService for high-level topic-based event dispatch
    if (options?.mcaEventSubscriptionService) {
      this.messageHandler.setMCAEventSubscriptionService(options.mcaEventSubscriptionService)
    }

    // Wire agent-usage instrumentation (forwarded to MessageHandler when present)
    if (options?.agentUsageSessionService) {
      this.messageHandler.setAgentUsageSessionService(options.agentUsageSessionService)
    }
    if (options?.toolExecutionService) {
      this.messageHandler.setToolExecutionService(options.toolExecutionService)
    }

    // Wire FeatureFlagService for runtime flag resolution (TER-386 tools.parallel-execution, …).
    if (options?.featureFlagService) {
      this.messageHandler.setFeatureFlagService(options.featureFlagService)
    }

    this.agentUsageHealthDeps = options?.agentUsageHealthDeps ?? null

    // Use injected McaService or fall back to a local instance.
    // Always wire the invalidation callback — the container-registered instance
    // doesn't have it because MessageHandler doesn't exist at DI registration time.
    this.mcaService = options?.mcaService ?? new McaService(db, {
      secretsManager: options?.secretsManager,
      workspaceService: options?.workspaceService ?? undefined,
      volumeService: options?.volumeService ?? undefined,
    })
    this.mcaService.setOnToolCacheInvalidate(
      (agentId) => this.messageHandler.invalidateToolCache(agentId),
    )
    this.modelService = options?.modelService ?? new ModelService(db)
    this.feedbackService = options?.feedbackService ?? new FeedbackService(db, this.pubSubService)
    this.mcaOAuth = options?.mcaOAuth
    this.userAuthManager = options?.authManager
    this.volumeService = options?.volumeService ?? null
    this.workspaceService = options?.workspaceService ?? null

    // Initialize command handlers with dependencies
    const baseDeps = {
      mcaService: this.mcaService,
      sendMessage: this.sendMessage.bind(this),
      sendError: this.sendError.bind(this),
    }

    // Initialize WsRouter with middleware and domain handlers
    this.wsRouter = new WsRouter()
    this.wsRouter.use(loggingMiddleware)
    registerProfileDomain(this.wsRouter, {
      db,
      userService: options?.userService ?? null,
    })
    registerAgentDomain(this.wsRouter, {
      db,
      providerService: this.providerService,
      workspaceService: options?.workspaceService ?? null,
      modelService: this.modelService,
      mcaService: this.mcaService,
      pubSubService: this.pubSubService ?? null,
    })
    if (options?.workspaceService) {
      registerWorkspaceDomain(this.wsRouter, {
        db,
        workspaceService: options.workspaceService,
        mcaService: this.mcaService,
        pubSubService: this.pubSubService ?? null,
      })
    }
    registerProviderDomain(this.wsRouter, {
      db,
      providerService: this.providerService,
      modelService: this.modelService,
    })
    registerChannelDomain(this.wsRouter, {
      channelManager: this.channelManager,
      sessionManager: this.sessionManager,
      pubSubService: this.pubSubService!,
      messageHandler: this.messageHandler,
      workspaceService: options?.workspaceService ?? null,
      db,
      getSessionId: (ws) => this.wsToSession.get(ws),
    })
    registerAppDomain(this.wsRouter, {
      db,
      mcaOAuth: options?.mcaOAuth,
      mcaManager: options?.mcaManager,
      workspaceService: options?.workspaceService,
      pubSubService: this.pubSubService ?? null,
      handlePermissionResponse: (requestId, granted) =>
        this.messageHandler.handlePermissionResponse(requestId, granted),
      applyPermissionToPendingRequests: (appId, toolName, permission) =>
        this.messageHandler.applyToolPermissionToPendingRequests(appId, toolName, permission),
      handleFormResponse: (formRequestId, payload) =>
        this.messageHandler.handleFormResponse(formRequestId, payload),
      // Pass the shared McaService so grant/revoke-access trigger onToolCacheInvalidate
      // and active conversations pick up the change without a backend restart.
      mcaService: this.mcaService,
    })
    if (options?.boardService && options?.workspaceService && options?.autoplayService && this.pubSubService) {
      registerBoardDomain(this.wsRouter, {
        boardService: options.boardService,
        boardSubscriptionService: options.boardSubscriptionService ?? undefined,
        workspaceService: options.workspaceService,
        sessionManager: this.sessionManager,
        pubSubService: this.pubSubService,
        channelManager: this.channelManager,
        messageHandler: this.messageHandler,
        eventHandler: options.eventHandler ?? undefined,
        autoplayService: options.autoplayService,
        db,
      })
    }
    registerAdminDomain(this.wsRouter, {
      db,
      userService: options?.userService ?? null,
      identityService: options?.identityService ?? null,
      sessionService: options?.sessionService ?? null,
      stripePaymentService: options?.stripePaymentService ?? null,
      // Without this, admin.resolve-access-request's `pubsub?.broadcastToUser` is a
      // silent no-op → the requester never gets the access-granted/denied push
      // (toast + unblock). Same class as the FASE6a billing-domain wiring gap.
      pubSubService: this.pubSubService,
    })
    registerAdminApiDomain(this.wsRouter, {
      db,
      mcaService: this.mcaService,
      mcaManager: options?.mcaManager,
      workspaceService: options?.workspaceService,
      featureFlagService: options?.featureFlagService ?? null,
      agentUsageHealthDeps: options?.agentUsageHealthDeps ?? null,
      latitudeSignalIndex: options?.latitudeSignalIndex ?? null,
      latitudeReadClient: options?.latitudeReadClient ?? null,
    })
    // billing domain: billing.* (user-facing payment-method vaulting). Only
    // registered when Stripe is wired — otherwise the actions stay absent.
    if (options?.stripePaymentService) {
      registerBillingDomain(this.wsRouter, {
        db,
        userService: options?.userService ?? null,
        stripePaymentService: options.stripePaymentService,
        pubSubService: this.pubSubService,
      })
    }
    if (options?.volumeService) {
      registerFileWatcherDomain(this.wsRouter, {
        db,
        volumeService: options.volumeService,
        workspaceService: options?.workspaceService ?? null,
        pubSubService: this.pubSubService!,
        getSessionId: (ws) => this.wsToSession.get(ws),
        getRegistry: (ws) => this.getOrCreateWatcherRegistry(ws),
      })
    }

    // skill domain: skill.* (always available)
    registerSkillDomain(this.wsRouter, {
      db,
      skillService: options?.skillService ?? null,
    })

    // project domain: project.* (always available)
    registerProjectDomain(this.wsRouter, {
      db,
      projectService: options?.projectService ?? null,
    })

    // desktop-state domain: desktop-state.get / desktop-state.save (always available)
    registerDesktopStateDomain(this.wsRouter, {
      db,
      desktopStateService: options?.desktopStateService ?? null,
    })

    // scheduler domain: scheduler.* — paths paralelos al MCA mca.teros.scheduler (criterio 22)
    registerSchedulerDomain(this.wsRouter, { db })

    // terminal domain: PTY-based interactive terminal
    registerTerminalDomain(this.wsRouter, {
      pubSubService: options?.pubSubService!,
      ptyManager: options?.ptyManager!,
      mcaService: this.mcaService,
      mcaManager: options?.mcaManager!,
      db,
    })

    // fs-browser domain: fs.list (requires both volumeService and workspaceService)
    if (options?.volumeService && options?.workspaceService) {
      registerFsBrowserDomain(this.wsRouter, {
        db,
        volumeService: options.volumeService,
        workspaceService: options.workspaceService,
      })
    }

    // file-share domain: file.share / file.unshare (always available when volumeService present)
    if (options?.volumeService) {
      registerFileShareDomain(this.wsRouter, {
        db,
        shareService: options?.shareService ?? new ShareService(db),
      })
    }

    // feature-flag domain: featureFlags.* (always available)
    registerFeatureFlagDomain(this.wsRouter, {
      db,
      userService: options?.userService ?? null,
      workspaceService: options?.workspaceService ?? null,
      featureFlagService: options?.featureFlagService ?? null,
    })

    // subscriptions domain: mca.subscribe-to-events / mca.unsubscribe-from-events / mca.list-event-subscriptions
    if (options?.mcaEventSubscriptionService) {
      registerSubscriptionsDomain(this.wsRouter, {
        mcaEventSubscriptionService: options.mcaEventSubscriptionService,
        channelManager: this.channelManager,
        db,
      })
    }

    // feedback domain: conversation.message.feedback / conversation.message.action / conversation.feedback
    if (this.feedbackService && options?.mcaManager) {
      registerFeedbackDomain(this.wsRouter, {
        db,
        feedbackService: this.feedbackService,
        mcaManager: options.mcaManager,
        pubSubService: this.pubSubService ?? null,
        latitudeScoreEmitter: options?.latitudeScoreEmitter ?? null,
      })
    }

    // Handle new connections
    this.wss.on("connection", (ws, request) => this.handleConnection(ws, request as IncomingMessage))

    log.info("WebSocketHandler initialized")
  }

  /**
   * Get the agent wake-up callback for EventHandler
   * This allows scheduled events to trigger agent responses
   */
  getAgentWakeUpCallback(): AgentWakeUpCallback {
    return (channelId, agentId, message, triggerKind) => {
      // Propagate the real origin (scheduled / event_subscription / …) so the
      // session records it instead of masquerading as user_message. TER-650.
      return this.messageHandler.processAgentResponse(
        channelId,
        agentId,
        message,
        undefined,
        undefined,
        triggerKind,
      )
    }
  }

  getWsRouter(): WsRouter {
    return this.wsRouter
  }

  getMessageHandler(): MessageHandler {
    return this.messageHandler
  }

  /**
   * Resolve the real client IP from the HTTP upgrade request.
   * Respects X-Forwarded-For (set by nginx/proxy in front of the backend).
   */
  private resolveIp(request: IncomingMessage): string {
    const forwarded = request.headers["x-forwarded-for"]
    if (forwarded) {
      // X-Forwarded-For can be a comma-separated list; first entry is the client
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0]
      return first.trim()
    }
    return request.socket?.remoteAddress ?? "unknown"
  }

  /**
   * Parse and route a single inbound WebSocket frame. Runs inside the per-message
   * isolation scope set by the `ws.on("message")` listener, so any error captured
   * here already carries the connection's user identity.
   */
  private async handleSocketMessage(ws: WebSocket, data: RawData): Promise<void> {
    const rawData = data.toString()
    const receivedBytes = Buffer.byteLength(rawData, "utf8")

    let message: any
    try {
      message = JSON.parse(rawData)
      if (message.type !== "ping") {
        log.debug({ preview: JSON.stringify(message).substring(0, 200) }, "Message received")
      }

      if (!isClientMessage(message)) {
        log.warn({ message: JSON.stringify(message) }, "Message failed validation")
        throw new Error("Invalid message format")
      }

      // Send message_ack for messages that need it (have requestId and are large or request ACK)
      const needsAck =
        message.type === "send_message" &&
        (message as any).requestId &&
        (receivedBytes > 10240 || (message as any).requireAck)

      if (needsAck) {
        this.sendMessage(ws, {
          type: "message_ack",
          requestId: (message as any).requestId,
          seq: (message as any).seq,
          receivedBytes,
          status: "received",
          serverTime: Date.now(),
        })
      }

      await this.handleClientMessage(ws, message)
    } catch (error) {
      log.error({ err: error }, "Error handling message")
      captureException(error, { context: "handleClientMessage", messageType: message?.type })
      const normalized = normalizeError(error)
      this.sendError(ws, "INVALID_MESSAGE", normalized.userMessage)
    }
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, request: IncomingMessage): void {
    const ip = this.resolveIp(request)
    this.wsToIp.set(ws, ip)
    log.info({ ip }, "New WebSocket connection")

    // Connection must authenticate within 30 seconds
    const authTimeout = setTimeout(() => {
      if (!this.wsToSession.has(ws)) {
        log.warn("Authentication timeout - closing connection")
        this.sendMessage(ws, {
          type: "auth_error",
          error: "Authentication timeout",
        })
        ws.close()
      }
    }, 30000)

    // Handle incoming messages
    ws.on("message", async (data) => {
      // Per-message isolation scope: every error captured while handling THIS
      // message (manual via captureException or automatic) inherits the user, and
      // concurrent messages from different users get independent scopes so one
      // user's identity never bleeds onto another's errors. Teros is a raw WS
      // server with no framework request-isolation, so we set it explicitly.
      // userId is undefined before auth (the first message is the handshake) —
      // correct: no identity to attach yet.
      const sessionId = this.wsToSession.get(ws)
      const userId = sessionId ? this.sessionManager.getSession(sessionId)?.userId : undefined
      await runWithRequestContext({ userId }, () => this.handleSocketMessage(ws, data))
    })

    // Handle disconnection
    ws.on("close", () => {
      clearTimeout(authTimeout)
      this.handleDisconnection(ws)
    })

    // Handle errors
    ws.on("error", (error) => {
      log.error({ err: error }, "WebSocket error")
    })
  }

  /**
   * Handle client message - routes to appropriate handler
   */
  private async handleClientMessage(ws: WebSocket, message: ClientMessage): Promise<void> {
    const logger = getWsLogger()
    const ip = this.wsToIp.get(ws) ?? "unknown"

    // Auth messages don't require existing session
    // Logging happens inside handleAuth where userId/sessionId are available
    if (message.type === "auth") {
      await this.handleAuth(ws, message, ip)
      return
    }

    // Ping messages - respond immediately with pong (no auth required for keepalive)
    if (message.type === "ping") {
      this.sendMessage(ws, {
        type: "pong",
        clientTime: (message as any).clientTime,
        serverTime: Date.now(),
      })
      return
    }

    // All other messages require authenticated session
    const sessionId = this.wsToSession.get(ws)
    if (!sessionId) {
      this.sendError(ws, "UNAUTHORIZED", "Not authenticated")
      return
    }

    const session = this.sessionManager.getSession(sessionId)
    if (!session) {
      this.sendError(ws, "SESSION_EXPIRED", "Session not found")
      ws.close()
      return
    }

    // Update activity
    this.sessionManager.updateActivity(sessionId)

    // WsFramework messages — dispatched to WsRouter (logged by loggingMiddleware)
    if (isWsRequest(message)) {
      const req = message as import("@teros/shared").WsRequest

      // Block users without platform access
      const hasAccess = await this.userService.hasAccess(session.userId)
      if (!hasAccess) {
        this.sendError(ws, "ACCESS_DENIED", "Platform access not granted. You are on the waitlist.")
        return
      }

      // ws is injected into ctx so handlers that need raw socket access (channel domain) can use it
      // sessionToken is included so impersonation handlers can hash it without client involvement
      const sessionToken = this.wsToToken.get(ws)
      const ctx = { userId: session.userId, sessionId: sessionId!, ws, ip, sessionToken }
      await this.wsRouter.dispatch(ws, ctx, req.requestId, req.action, req.data ?? {})
      return
    }

    // Unknown message type — log it
    logger.write({
      ts: new Date().toISOString(),
      ip,
      userId: session.userId,
      sessionId,
      action: `unknown:${(message as any).type ?? "?"}`,
      inputBytes: jsonBytes(message),
      outputBytes: 0,
      durationMs: 0,
      status: "error",
      errorCode: "UNKNOWN_MESSAGE_TYPE",
      errorMsg: `Unknown message type: ${(message as any).type}`,
    })
    this.sendError(ws, "UNKNOWN_MESSAGE_TYPE", `Unknown message type: ${(message as any).type}`)
  }

  /**
   * Handle authentication
   */
  private async handleAuth(ws: WebSocket, message: AuthMessage, ip: string): Promise<void> {
    const logger = getWsLogger()
    const start = Date.now()
    const inputBytes = jsonBytes(message)

    try {
      const result = await this.authHandler.authenticate(message)

      // Handle Google OAuth init - returns URL instead of session
      if (result.url && result.state) {
        this.sendMessage(ws, {
          type: "google_auth_url",
          url: result.url,
          state: result.state,
        })
        logger.write({
          ts: new Date().toISOString(),
          ip,
          userId: "anon",
          sessionId: "anon",
          action: "auth:oauth-init",
          inputBytes,
          outputBytes: 0,
          durationMs: Date.now() - start,
          status: "ok",
        })
        return
      }

      if (!result.success) {
        this.sendMessage(ws, {
          type: "auth_error",
          error: result.error || "Authentication failed",
        })
        logger.write({
          ts: new Date().toISOString(),
          ip,
          userId: "anon",
          sessionId: "anon",
          action: "auth",
          inputBytes,
          outputBytes: 0,
          durationMs: Date.now() - start,
          status: "error",
          errorCode: "AUTH_FAILED",
          errorMsg: result.error ?? "Authentication failed",
        })
        ws.close()
        return
      }

      // Create session
      const session = this.sessionManager.createSession(result.userId!, ws)
      this.wsToSession.set(ws, session.sessionId)
      // Store raw token so impersonation handlers can hash it
      this.wsToToken.set(ws, result.sessionToken!)

      // Send success
      this.sendMessage(ws, {
        type: "auth_success",
        userId: result.userId!,
        sessionToken: result.sessionToken!,
        role: (result.user?.role || "user") as "user" | "admin" | "super",
        user: result.user ? {
          profile: result.user.profile,
          termsAcceptedAt: result.user.termsAcceptedAt,
          onboardingCompletedAt: result.user.onboardingCompletedAt,
          accessGranted: result.user.accessGranted,
        } : undefined,
        ...(result.impersonation ? { impersonation: result.impersonation } : {}),
      })

      // Send connection_ack with protocol configuration
      this.sendMessage(ws, {
        type: "connection_ack",
        sessionId: session.sessionId,
        serverTime: Date.now(),
        config: {
          pingIntervalMs: 30000, // Client should ping every 30s
          pongTimeoutMs: 10000, // Client should wait max 10s for pong
          maxMessageSizeBytes: 10485760, // 10MB max message size
          ackRequiredAboveBytes: 10240, // ACK for messages > 10KB
        },
        serverVersion: "2.0.0",
      })

      logger.write({
        ts: new Date().toISOString(),
        ip,
        userId: result.userId!,
        sessionId: session.sessionId,
        action: "auth",
        inputBytes,
        outputBytes: 0,
        durationMs: Date.now() - start,
        status: "ok",
      })

      log.info({ userId: result.userId, ip }, "User authenticated")
    } catch (error) {
      log.error({ err: error }, "Auth error")
      const errorMessage = error instanceof Error ? error.message : "Authentication failed"
      logger.write({
        ts: new Date().toISOString(),
        ip,
        userId: "anon",
        sessionId: "anon",
        action: "auth",
        inputBytes,
        outputBytes: 0,
        durationMs: Date.now() - start,
        status: "error",
        errorCode: "AUTH_EXCEPTION",
        errorMsg: errorMessage.slice(0, 200),
      })
      this.sendMessage(ws, {
        type: "auth_error",
        error: errorMessage,
      })
      ws.close()
    }
  }

  /**
   * Handle disconnection
   */
  private handleDisconnection(ws: WebSocket): void {
    const sessionId = this.wsToSession.get(ws)
    if (sessionId) {
      // Pending permission requests are intentionally NOT cleared here: with no
      // auto-deny countdown, a request waits for the user indefinitely. The
      // in-memory pending (and its parked resolver promise) survives the
      // disconnect so that on reconnect restorePendingApprovals re-broadcasts
      // it and handleResponse resolves the ORIGINAL promise — the live agent
      // turn continues instead of being denied out from under the user.
      this.sessionManager.removeSession(sessionId)
    }
    this.wsToToken.delete(ws)
    // Clean up any file watchers for this connection
    // (PubSubService topic subscriptions are cleaned up via sessionManager.removeSession → pubSubService.unregisterSession)
    const registry = this.wsToWatcherRegistry.get(ws)
    if (registry) {
      cleanupWatcherRegistry(registry)
      this.wsToWatcherRegistry.delete(ws)
    }
    log.info("WebSocket disconnected")
  }

  /**
   * Get or lazily create a WatcherRegistry for this WS connection.
   * Each connection gets its own isolated registry.
   */
  private getOrCreateWatcherRegistry(ws: WebSocket): WatcherRegistry {
    let registry = this.wsToWatcherRegistry.get(ws)
    if (!registry) {
      registry = createWatcherRegistry()
      this.wsToWatcherRegistry.set(ws, registry)
    }
    return registry
  }

  /**
   * Send message to WebSocket
   */
  sendMessage(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message))
    }
  }

  /**
   * Send error message
   */
  private sendError(ws: WebSocket, code: string, message: string): void {
    this.sendMessage(ws, {
      type: "error",
      code,
      message,
    })
  }
}
