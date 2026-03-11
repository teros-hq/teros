/**
 * WebSocket Handler
 * Handles WebSocket connections and message routing
 */

import type { ILLMClient, SessionStore } from "@teros/core"
import type { AuthMessage, ClientMessage, ServerMessage } from "@teros/shared"
import { isClientMessage, isWsRequest, parseClientMessage } from "@teros/shared"
import type { Db } from "mongodb"
import type { IncomingMessage } from "http"
import type { WebSocket, WebSocketServer } from "ws"
import type { AuthManager } from "../auth/auth-manager"
import type { McaOAuth } from "../auth/mca-oauth"
import { config } from "../config"
import { captureException } from "../lib/sentry"
import { getWsLogger, jsonBytes } from "../lib/ws-logger"
import type { SecretsManager } from "../secrets/secrets-manager"
import type { BoardService } from "../services/board-service"
import type { ChannelManager } from "../services/channel-manager"
import type { McaManager } from "../services/mca-manager"
import { McaService } from "../services/mca-service"
import { ModelService } from "../services/model-service"
import { ProviderService } from "../services/provider-service"
import type { SessionManager } from "../services/session-manager"
import type { VolumeService } from "../services/volume-service"
import type { WorkspaceService } from "../services/workspace-service"
import { loggingMiddleware, WsRouter } from "../ws-framework"
import { SubscriptionManager } from "../ws-framework/SubscriptionManager"
import { UserService } from "../auth/user-service"
import { AuthHandler } from "./auth-handler"
import { register as registerAdminDomain } from "./domains/admin"
import { register as registerAdminApiDomain } from "./domains/admin-api"
import { register as registerAgentDomain } from "./domains/agent"
import { register as registerAppDomain } from "./domains/app"
import { register as registerBoardDomain } from "./domains/board"
import { register as registerChannelDomain } from "./domains/channel"
import {
  cleanupWatcherRegistry,
  createWatcherRegistry,
  register as registerFileWatcherDomain,
  type WatcherRegistry,
} from "./domains/file-watcher"
import { register as registerProfileDomain } from "./domains/profile"
import { register as registerProviderDomain } from "./domains/provider"
import { register as registerWorkspaceDomain } from "./domains/workspace"
import type { EventHandler } from "./event-handler"
import { MessageHandler } from "./message-handler"

export interface WebSocketHandlerOptions {
  authHandler?: AuthHandler
  mcaManager?: McaManager | null
  llmClient?: ILLMClient
  toolExecutor?: any // Mock tool executor for tests
  secretsManager?: SecretsManager
  mcaOAuth?: McaOAuth | null
  authManager?: AuthManager | null
  workspaceService?: WorkspaceService | null
  volumeService?: VolumeService | null
  boardService?: BoardService | null
  eventHandler?: EventHandler | null
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

  // Map WebSocket to sessionId for quick lookup
  private wsToSession: WeakMap<WebSocket, string> = new WeakMap()

  // Map WebSocket to client IP (captured at connection time)
  private wsToIp: WeakMap<WebSocket, string> = new WeakMap()

  // UserService for access control checks
  private userService: UserService

  // New WsRouter — handles framework-migrated actions
  private wsRouter: WsRouter

  // Shared SubscriptionManager for file-watcher (and future pub/sub domains)
  private subscriptionManager: SubscriptionManager = new SubscriptionManager()

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
    this.userService = new UserService(db)
    this.providerService = new ProviderService(db)
    this.messageHandler = new MessageHandler(
      channelManager,
      sessionManager,
      db,
      sessionStore,
      options?.mcaManager, // Pass shared McaManager instead of basePath
      options?.llmClient,
      options?.toolExecutor,
      options?.secretsManager,
    )

    // Wire board service + event handler for automatic task running detection
    if (options?.boardService && options?.eventHandler) {
      this.messageHandler.setTaskServices(options.boardService, options.eventHandler)
    }

    // Pass tool cache invalidation callback to McaService
    this.mcaService = new McaService(db, {
      onToolCacheInvalidate: (agentId) => this.messageHandler.invalidateToolCache(agentId),
      secretsManager: options?.secretsManager,
      workspaceService: options?.workspaceService ?? undefined,
      volumeService: options?.volumeService ?? undefined,
    })
    this.modelService = new ModelService(db)
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
    registerProfileDomain(this.wsRouter, { db })
    registerAgentDomain(this.wsRouter, {
      db,
      providerService: this.providerService,
      workspaceService: options?.workspaceService ?? null,
    })
    if (options?.workspaceService) {
      registerWorkspaceDomain(this.wsRouter, {
        db,
        workspaceService: options.workspaceService,
      })
    }
    registerProviderDomain(this.wsRouter, {
      db,
      providerService: this.providerService,
    })
    registerChannelDomain(this.wsRouter, {
      channelManager: this.channelManager,
      sessionManager: this.sessionManager,
      messageHandler: this.messageHandler,
      getSessionId: (ws) => this.wsToSession.get(ws),
    })
    registerAppDomain(this.wsRouter, {
      db,
      mcaOAuth: options?.mcaOAuth,
      mcaManager: options?.mcaManager,
      workspaceService: options?.workspaceService,
      handlePermissionResponse: (requestId, granted) =>
        this.messageHandler.handlePermissionResponse(requestId, granted),
    })
    if (options?.boardService && options?.workspaceService) {
      registerBoardDomain(this.wsRouter, {
        boardService: options.boardService,
        workspaceService: options.workspaceService,
        sessionManager: this.sessionManager,
        channelManager: this.channelManager,
        messageHandler: this.messageHandler,
        db,
      })
    }
    registerAdminDomain(this.wsRouter, { db })
    registerAdminApiDomain(this.wsRouter, {
      db,
      mcaService: this.mcaService,
      mcaManager: options?.mcaManager,
      workspaceService: options?.workspaceService,
    })
    if (options?.volumeService) {
      registerFileWatcherDomain(this.wsRouter, {
        db,
        volumeService: options.volumeService,
        workspaceService: options?.workspaceService ?? null,
        subscriptionManager: this.subscriptionManager,
        getRegistry: (ws) => this.getOrCreateWatcherRegistry(ws),
      })
    }

    // Handle new connections
    this.wss.on("connection", (ws, request) => this.handleConnection(ws, request as IncomingMessage))

    console.log("✅ WebSocketHandler initialized")
  }

  /**
   * Build full avatar URL from filename
   */
  private buildAvatarUrl(avatarFilename?: string): string | undefined {
    if (!avatarFilename) return undefined
    return `${config.static.baseUrl}/${avatarFilename}`
  }

  /**
   * Get the agent wake-up callback for EventHandler
   * This allows scheduled events to trigger agent responses
   */
  getAgentWakeUpCallback(): (channelId: string, agentId: string, message: string) => Promise<void> {
    return (channelId: string, agentId: string, message: string) => {
      return this.messageHandler.processAgentResponse(channelId, agentId, message)
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
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, request: IncomingMessage): void {
    const ip = this.resolveIp(request)
    this.wsToIp.set(ws, ip)
    console.log(`🔌 New WebSocket connection from ${ip}`)

    // Connection must authenticate within 30 seconds
    const authTimeout = setTimeout(() => {
      if (!this.wsToSession.has(ws)) {
        console.log("⏰ Authentication timeout - closing connection")
        this.sendMessage(ws, {
          type: "auth_error",
          error: "Authentication timeout",
        })
        ws.close()
      }
    }, 30000)

    // Handle incoming messages
    ws.on("message", async (data) => {
      const rawData = data.toString()
      const receivedBytes = Buffer.byteLength(rawData, "utf8")

      let message: any
      try {
        message = JSON.parse(rawData)
        if (message.type !== "ping") {
          console.log("📨 Received message:", JSON.stringify(message).substring(0, 200))
        }

        if (!isClientMessage(message)) {
          console.log("❌ Message failed validation:", JSON.stringify(message))
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
        console.error("❌ Error handling message:", error)
        captureException(error, { context: "handleClientMessage", messageType: message?.type })
        const errorMessage = error instanceof Error ? error.message : "Unknown error"
        this.sendError(ws, "INVALID_MESSAGE", errorMessage)
      }
    })

    // Handle disconnection
    ws.on("close", () => {
      clearTimeout(authTimeout)
      this.handleDisconnection(ws)
    })

    // Handle errors
    ws.on("error", (error) => {
      console.error("❌ WebSocket error:", error)
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

      // Actions allowed for users without platform access (needed for the invitation gate UI)
      const ACCESS_GATE_WHITELIST = ["admin.get-invitation-status", "admin.get-invitations-sent"]

      if (!ACCESS_GATE_WHITELIST.includes(req.action)) {
        const hasAccess = await this.userService.hasAccess(session.userId)
        if (!hasAccess) {
          this.sendError(ws, "ACCESS_DENIED", "Platform access not granted. You need invitations to access Teros.")
          return
        }
      }

      // ws is injected into ctx so handlers that need raw socket access (channel domain) can use it
      const ctx = { userId: session.userId, sessionId: sessionId!, ws, ip }
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

      // Send success
      this.sendMessage(ws, {
        type: "auth_success",
        userId: result.userId!,
        sessionToken: result.sessionToken!,
        role: (result.user?.role || "user") as "user" | "admin" | "super",
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

      console.log(`✅ User authenticated: ${result.userId} from ${ip}`)
    } catch (error) {
      console.error("❌ Auth error:", error)
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
      this.sessionManager.removeSession(sessionId)
    }
    // Clean up any file watchers and subscriptions for this connection
    const registry = this.wsToWatcherRegistry.get(ws)
    if (registry) {
      cleanupWatcherRegistry(registry)
      this.wsToWatcherRegistry.delete(ws)
    }
    this.subscriptionManager.cleanup(ws)
    console.log("👋 WebSocket disconnected")
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
