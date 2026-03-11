/**
 * Teros Backend - WebSocket Server
 *
 * Entry point for the Teros backend server.
 * Uses dependency injection for service management.
 *
 * LLM configuration is dynamic per agent:
 * - Models are defined in the 'models' collection
 * - Agent cores reference models and can override defaults
 * - MessageHandler creates LLM clients dynamically based on agent config
 */

import { readFile } from "fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { type Db, MongoClient } from "mongodb"
import { dirname, extname, join, resolve } from "path"
import { fileURLToPath } from "url"
import { WebSocketServer } from "ws"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Auth
import { AuthManager } from "./auth/auth-manager"
import { initAuthService } from "./auth/auth-service"
import { initGoogleAuth } from "./auth/google-auth"
import { initMcaOAuth, type McaOAuth } from "./auth/mca-oauth"
import { config } from "./config"
import { type Container, createContainer, Tokens } from "./container"
// Handlers
import { EventHandler, type ScheduledEvent } from "./handlers/event-handler"
import { HttpAuthHandler } from "./handlers/http-auth-handler"
import { HttpFileHandler } from "./handlers/http-file-handler"
import { HttpMcaAuthHandler } from "./handlers/http-mca-auth-handler"
import { HttpMediaHandler } from "./handlers/http-media-handler"
import { HttpUploadHandler } from "./handlers/http-upload-handler"
import { VoiceHandler } from "./handlers/voice-handler"
import { WebSocketHandler } from "./handlers/websocket-handler"
// Sentry Error Tracking
import { captureException, flush as flushSentry, initSentry } from "./lib/sentry"
import { createAdminRoutes } from "./routes/admin-routes"
import { createBoardRoutes } from "./routes/board-routes"
import { createMcaCallbackRoutes } from "./routes/mca-callback-routes"
import { createProviderOAuthRoutes } from "./routes/provider-oauth-routes"
// Secrets
import { SecretsManager, secrets } from "./secrets/secrets-manager"
import { BoardService } from "./services/board-service"
import { ChannelManager } from "./services/channel-manager"
import { McaConnectionManager } from "./services/mca-connection-manager"
import { McaManager } from "./services/mca-manager"
import { McaService } from "./services/mca-service"
import { ModelService } from "./services/model-service"
import { ProviderService } from "./services/provider-service"
import { ResumeService } from "./services/resume-service"
import { SchedulerService } from "./services/scheduler-service"
// Services
import { SessionManager } from "./services/session-manager"
import { UsageService } from "./services/usage-service"
import { VolumeService } from "./services/volume-service"
import { WorkspaceService } from "./services/workspace-service"
// Session
import { MongoSessionStore } from "./session/MongoSessionStore"

// Sync
import { runSync } from "./sync"

// MCA Boot Sync (background, non-blocking)
import { runMcaBootSync } from './services/mca-boot-sync';

// ============================================================================
// CONSTANTS
// ============================================================================

const MIME_TYPES: Record<string, string> = {
  // Images
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  // Documents
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Text
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".ts": "application/typescript",
  // Archives
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
  // Video
  ".mp4": "video/mp4",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
}

const STATIC_DIR = join(__dirname, "..", "static")
const UPLOADS_DIR = join(__dirname, "..", "uploads")

// ============================================================================
// CONTAINER SETUP
// ============================================================================

/**
 * Register all dependencies in the container
 */
function registerDependencies(
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

  // Session management
  container.register(Tokens.SessionManager, () => new SessionManager())
  container.register(Tokens.SessionStore, (c) => new MongoSessionStore(c.get(Tokens.Db)))

  // Business services
  container.register(Tokens.ProviderService, (c) => new ProviderService(c.get(Tokens.Db)))
  container.register(
    Tokens.ChannelManager,
    (c) => new ChannelManager(c.get(Tokens.Db), c.get(Tokens.ProviderService)),
  )
  container.register(Tokens.UsageService, (c) => new UsageService(c.get(Tokens.Db)))
  container.register(Tokens.ModelService, (c) => new ModelService(c.get(Tokens.Db)))

  // Volume Service
  container.register(
    Tokens.VolumeService,
    (c) =>
      new VolumeService(c.get(Tokens.Db), {
        basePath: config.volumes.basePath,
        defaultUserQuota: config.volumes.defaultUserQuota,
        defaultWorkspaceQuota: config.volumes.defaultWorkspaceQuota,
      }),
  )

  // Workspace Service (must be before McaService)
  container.register(
    Tokens.WorkspaceService,
    (c) => new WorkspaceService(c.get(Tokens.Db), c.get(Tokens.VolumeService)),
  )

  // Board Service (needs to be before WebSocketHandler)
  container.register(Tokens.BoardService, (c) => new BoardService(c.get(Tokens.Db)))

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

  // Scheduler service
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
}

// ============================================================================
// HTTP SERVER
// ============================================================================

interface HttpHandlers {
  adminRoutes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  boardRoutes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  mcaCallbackRoutes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  providerOAuthRoutes: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>
  authHandler: HttpAuthHandler
  mcaAuthHandler: HttpMcaAuthHandler
  uploadHandler: HttpUploadHandler
  mediaHandler: HttpMediaHandler
  fileHandler: HttpFileHandler
  eventHandler: EventHandler
  sessionManager: SessionManager
  mcaManager: McaManager | null
}

/**
 * Create HTTP request handler
 */
function createHttpHandler(handlers: HttpHandlers) {
  const {
    adminRoutes,
    boardRoutes,
    mcaCallbackRoutes,
    providerOAuthRoutes,
    authHandler,
    mcaAuthHandler,
    uploadHandler,
    mediaHandler,
    fileHandler,
    eventHandler,
    sessionManager,
    mcaManager,
  } = handlers

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "/"
    const method = req.method || "GET"

    // Debug log for static files
    if (url.startsWith("/static/")) {
      console.log(`[HTTP] Static file request: ${method} ${url}`)
    }

    // Debug log for callback routes
    if (url.startsWith("/mca/callback/")) {
      console.log(`[HTTP] Received MCA callback: ${method} ${url}`)
    }

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

    // Handle preflight
    if (method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    // OAuth callback routes
    if (url.startsWith("/auth/") || url.startsWith("/api/auth/")) {
      if (await mcaAuthHandler.handleRoute(req, res, url)) return
      if (await authHandler.handleRoute(req, res, url)) return
    }

    // Redirect root to health check
    if (url === "/") {
      res.writeHead(302, { Location: "/health" })
      res.end()
      return
    }

    // Health check
    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          status: "ok",
          timestamp: new Date().toISOString(),
          connections: sessionManager.getConnectionCount(),
          mcaManager: mcaManager ? "active" : "disabled",
        }),
      )
      return
    }

    // Upload API
    if (url.startsWith("/api/upload/")) {
      if (await uploadHandler.handleRoute(req, res, url)) return
    }

    // Media API (for messaging multimedia)
    if (url.startsWith("/api/media/") || url.startsWith("/media/")) {
      if (await mediaHandler.handleRoute(req, res, url)) return
    }

    // File API (serves workspace files for HtmlFileBubble)
    if (url.startsWith("/api/files")) {
      if (await fileHandler.handleRoute(req, res, url)) return
    }

    // Event API (for scheduler)
    if (url === "/api/event" && method === "POST") {
      await handleEventRoute(req, res, eventHandler)
      return
    }

    // Board dependency routes
    if (url.startsWith("/api/tasks/")) {
      if (await boardRoutes(req, res, url)) return
    }

    // Admin routes
    if (url.startsWith("/admin/")) {
      if (await adminRoutes(req, res, url)) return
    }

    // Provider OAuth routes (user LLM providers)
    if (url.startsWith("/api/providers/oauth/")) {
      if (await providerOAuthRoutes(req, res, url)) return
    }

    // MCA callback routes (MCA → Backend)
    if (url.startsWith("/mca/callback/")) {
      if (await mcaCallbackRoutes(req, res, url)) return
    }

    // Static files
    if (url.startsWith("/static/")) {
      await handleStaticFile(req, res, url)
      return
    }

    // Uploaded files (voice notes, etc.)
    if (url.startsWith("/uploads/")) {
      await handleUploadedFile(req, res, url)
      return
    }

    res.writeHead(404)
    res.end("Not Found")
  }
}

/**
 * Handle /api/event route
 */
async function handleEventRoute(
  req: IncomingMessage,
  res: ServerResponse,
  eventHandler: EventHandler,
): Promise<void> {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks).toString()
    const event: ScheduledEvent = JSON.parse(body)

    if (!event.channelId || !event.message || !event.eventType) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          success: false,
          error: "Missing required fields: channelId, message, eventType",
        }),
      )
      return
    }

    const result = await eventHandler.handleScheduledEvent(event)

    res.writeHead(result.success ? 200 : 400, { "Content-Type": "application/json" })
    res.end(JSON.stringify(result))
  } catch (error) {
    console.error("❌ Error handling /api/event:", error)
    res.writeHead(500, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      }),
    )
  }
}

/**
 * Handle static file requests
 *
 * For MCA assets: /static/mcas/<mca-id>/<file> → mcas/<mca-id>/static/<file>
 * For other assets: /static/<file> → packages/backend/static/<file>
 */
async function handleStaticFile(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
): Promise<void> {
  const filename = url.slice(8) // Remove '/static/'
  const ext = extname(filename).toLowerCase()
  const mimeType = MIME_TYPES[ext] || "application/octet-stream"

  // Resolve file path: MCA assets are served directly from mcas/<id>/static/
  let filePath: string
  const mcaMatch = filename.match(/^mcas\/([^/]+)\/(.+)$/)
  if (mcaMatch) {
    const [, mcaId, relativePath] = mcaMatch
    filePath = join(resolve(config.mca.basePath), mcaId, "static", relativePath)
  } else {
    filePath = join(STATIC_DIR, filename)
  }

  try {
    const data = await readFile(filePath)
    res.writeHead(200, {
      "Content-Type": mimeType,
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
    })
    res.end(data)
  } catch (error) {
    res.writeHead(404)
    res.end("Not Found")
  }
}

/**
 * Handle uploaded file requests (voice notes, etc.)
 */
async function handleUploadedFile(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
): Promise<void> {
  const filename = url.slice(9) // Remove '/uploads/'
  const ext = extname(filename).toLowerCase()

  // Extended MIME types for audio
  const audioMimeTypes: Record<string, string> = {
    ...MIME_TYPES,
    ".webm": "audio/webm",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
  }

  const mimeType = audioMimeTypes[ext]

  if (!mimeType) {
    res.writeHead(404)
    res.end("Not Found")
    return
  }

  try {
    const filePath = join(UPLOADS_DIR, filename)
    const data = await readFile(filePath)
    res.writeHead(200, {
      "Content-Type": mimeType,
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end("Not Found")
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log("Teros Backend starting...")

  // -------------------------------------------------------------------------
  // SENTRY ERROR TRACKING
  // -------------------------------------------------------------------------
  initSentry({
    environment: process.env.NODE_ENV || "development",
  })

  // -------------------------------------------------------------------------
  // SYNC (MCAs, Models, Tools)
  // -------------------------------------------------------------------------
  // Sync is now run manually via `bun run sync` when needed
  // await runSync();

  // -------------------------------------------------------------------------
  // SECRETS
  // -------------------------------------------------------------------------

  console.log("Loading secrets...")
  const secretsPath = join(__dirname, "../../../.secrets")
  process.env.SECRETS_PATH = secretsPath

  const secretsManager = new SecretsManager(secretsPath)
  await secretsManager.load()

  // Also load singleton secrets instance
  ;(secrets as any).basePath = secretsPath
  await secrets.load()

  // -------------------------------------------------------------------------
  // REQUIRED SECRETS VALIDATION
  // Fail fast with a clear message if critical secrets are missing
  // -------------------------------------------------------------------------

  const missingSecrets: string[] = []
  if (!secretsManager.hasSystem("encryption")) {
    missingSecrets.push(
      ".secrets/system/encryption.json (required for encrypting user credentials)",
    )
  }
  if (missingSecrets.length > 0) {
    console.error("❌ Missing required secrets:")
    missingSecrets.forEach((s) => console.error(`   - ${s}`))
    console.error("\nSee .secrets/system/*.example.json for reference.")
    process.exit(1)
  }

  // -------------------------------------------------------------------------
  // DATABASE
  // Priority: env var (for Docker/infra overrides) > SecretsManager > defaults
  // -------------------------------------------------------------------------

  console.log("Connecting to MongoDB...")
  const dbSecret = secretsManager.system("database")
  const mongoUri = process.env.MONGODB_URI || dbSecret?.uri || "mongodb://localhost:27017"
  const mongoDatabase = process.env.MONGODB_DATABASE || dbSecret?.database || "teros"
  const mongoClient = new MongoClient(mongoUri)
  await mongoClient.connect()
  const db = mongoClient.db(mongoDatabase)
  console.log(`MongoDB connected (${mongoDatabase})`)

  // -------------------------------------------------------------------------
  // AUTH SERVICES
  // -------------------------------------------------------------------------

  const authManager = new AuthManager(db)
  console.log("AuthManager initialized")

  const authService = initAuthService(db)
  await authService.ensureIndexes()
  console.log("AuthService initialized")

  // Initialize invitation indexes
  const { InvitationService } = await import("./auth/invitation-service")
  const invitationService = new InvitationService(db)
  await invitationService.ensureIndexes()
  console.log("InvitationService initialized")

  // Google OAuth (optional)
  const oauthSecrets = secretsManager.system("oauth")
  if (oauthSecrets?.google?.clientId && oauthSecrets?.google?.clientSecret) {
    const googleAuth = initGoogleAuth(db, {
      clientId: oauthSecrets.google.clientId,
      clientSecret: oauthSecrets.google.clientSecret,
      redirectUri:
        oauthSecrets.google.redirectUri ||
        `http://localhost:${config.server.port}/auth/google/callback`,
    })
    await googleAuth.ensureIndexes()
    console.log("Google OAuth initialized")
  } else {
    console.log("Google OAuth: not configured")
  }

  // MCA OAuth
  const mcaOAuth = initMcaOAuth(db, authManager, secretsManager)
  await mcaOAuth.ensureIndexes()
  console.log("MCA OAuth initialized")

  // -------------------------------------------------------------------------
  // DEPENDENCY INJECTION CONTAINER
  // -------------------------------------------------------------------------

  const container = createContainer()
  registerDependencies(container, db, secretsManager, authManager, mcaOAuth)
  await container.init()
  console.log("Container initialized")

  // Get services from container
  const sessionManager = container.get(Tokens.SessionManager)
  const channelManager = container.get(Tokens.ChannelManager)
  const mcaService = container.get(Tokens.McaService)
  const workspaceService = container.get(Tokens.WorkspaceService)
  const volumeService = container.get(Tokens.VolumeService)
  const usageService = container.get(Tokens.UsageService)
  const eventHandler = container.get(Tokens.EventHandler)
  const sessionStore = container.get(Tokens.SessionStore)

  // Connect WorkspaceService to McaService (late binding to avoid circular deps)
  mcaService.setWorkspaceService(workspaceService)

  // Ensure ChannelManager indexes
  await channelManager.ensureIndexes()

  // Ensure McaService indexes
  await mcaService.ensureIndexes()

  // Ensure WorkspaceService indexes
  await workspaceService.ensureIndexes()

  // Board Service
  const boardService = container.get(Tokens.BoardService)
  await boardService.ensureIndexes()

  // MCA Manager is optional
  const mcaManager = container.has(Tokens.McaManager) ? container.get(Tokens.McaManager) : null

  if (mcaManager) {
    const mcaBasePath = resolve(config.mca.basePath!)
    console.log(`MCA Manager initialized (base path: ${mcaBasePath})`)
  }

  console.log("Session store initialized")
  if (secretsManager.hasSystem("anthropic")) {
    console.log("LLM support: Anthropic API key configured (system secret)")
  } else {
    console.log("LLM support: No system Anthropic key — users must configure their own provider")
  }

  // -------------------------------------------------------------------------
  // HTTP HANDLERS
  // -------------------------------------------------------------------------

  const httpAuthHandler = new HttpAuthHandler(sessionManager, secretsManager)
  const httpMcaAuthHandler = new HttpMcaAuthHandler(
    mcaOAuth,
    mcaService,
    authService,
    secretsManager,
  )
  const httpUploadHandler = new HttpUploadHandler(db)
  const httpMediaHandler = new HttpMediaHandler()
  const httpFileHandler = new HttpFileHandler(db, authService, volumeService, workspaceService)

  const adminRoutes = createAdminRoutes({ db, secretsManager })

  const boardRoutes = createBoardRoutes({ boardService, workspaceService, sessionManager })

  const mcaCallbackRoutes = createMcaCallbackRoutes({
    db,
    secretsManager,
    authManager,
    workspaceService,
    volumeService,
  })

  const providerOAuthRoutes = createProviderOAuthRoutes({
    db,
  })

  // -------------------------------------------------------------------------
  // HTTP SERVER
  // -------------------------------------------------------------------------

  const httpHandler = createHttpHandler({
    adminRoutes,
    boardRoutes,
    mcaCallbackRoutes,
    providerOAuthRoutes,
    authHandler: httpAuthHandler,
    mcaAuthHandler: httpMcaAuthHandler,
    uploadHandler: httpUploadHandler,
    mediaHandler: httpMediaHandler,
    fileHandler: httpFileHandler,
    eventHandler,
    sessionManager,
    mcaManager,
  })

  const httpServer = createServer(httpHandler)

  // -------------------------------------------------------------------------
  // WEBSOCKET SERVER
  // -------------------------------------------------------------------------

  // Use noServer mode to handle multiple WebSocket paths manually
  const wss = new WebSocketServer({ noServer: true })
  console.log("WebSocket server created (noServer mode)")

  const wsHandler = new WebSocketHandler(wss, sessionManager, channelManager, db, sessionStore, {
    secretsManager,
    mcaManager,
    mcaOAuth,
    authManager,
    workspaceService,
    volumeService,
    boardService,
    eventHandler,
  })

  // Connect EventHandler to WebSocketHandler
  eventHandler.setAgentWakeUpCallback(wsHandler.getAgentWakeUpCallback())

  // -------------------------------------------------------------------------
  // VOICE HANDLER (WebSocket for ElevenLabs Conversational AI)
  // -------------------------------------------------------------------------

  const voiceHandler = new VoiceHandler(
    db,
    sessionManager,
    channelManager,
    secretsManager,
    wsHandler.getMessageHandler(),
  )
  console.log("VoiceHandler initialized")

  // -------------------------------------------------------------------------
  // MCA CONNECTION MANAGER (WebSocket for MCA bidirectional communication)
  // -------------------------------------------------------------------------

  let mcaConnectionManager: McaConnectionManager | undefined
  if (mcaManager) {
    mcaConnectionManager = new McaConnectionManager(db, {
      secretsManager,
      authManager,
      channelManager,
      boardService,
      sessionManager,
      wsRouter: wsHandler.getWsRouter(),
    })
    mcaConnectionManager.initWebSocketServer(httpServer)
    await mcaConnectionManager.ensureIndexes()
    mcaManager.setConnectionManager(mcaConnectionManager)
    mcaOAuth.setConnectionManager(mcaConnectionManager)

    // Handle MCA events - inject into channels
    mcaConnectionManager.on("mca:event", async (event) => {
      console.log(`[Main] MCA event received: ${event.eventType} from ${event.appId}`)
      // TODO: Route event to appropriate channel via eventHandler
      // await eventHandler.injectMcaEvent(event);
    })

    // Handle MCA health updates - update cached health in McaManager
    mcaConnectionManager.on("mca:health", (appId, update) => {
      console.log(`[Main] MCA health update: ${appId} -> ${update.status}`)
      mcaManager.updateHealthFromWebSocket(appId, update.status, update.issues)
    })

    // Handle send_message from MCA - trigger agent response
    mcaConnectionManager.on("mca:send_message", async ({ channelId, agentId, message }) => {
      console.log(`[Main] MCA send_message: channelId=${channelId}, agentId=${agentId}`)
      try {
        const wakeUpCallback = wsHandler.getAgentWakeUpCallback()
        await wakeUpCallback(channelId, agentId, message)
      } catch (error) {
        console.error(`[Main] Error processing MCA send_message:`, error)
      }
    })

    // Handle credentials expired - try to refresh, then notify MCA
    mcaConnectionManager.on("mca:credentials_expired", async (appId, reason) => {
      console.log(`[Main] MCA credentials expired: ${appId} - ${reason}`)

      // Try to refresh the token
      try {
        const app = await mcaService.getApp(appId)
        if (app) {
          console.log(`[Main] Attempting token refresh for ${appId}...`)
          const refreshResult = await mcaOAuth.refreshToken(app.ownerId, appId, app.mcaId)

          if (refreshResult.success) {
            console.log(`[Main] Token refreshed successfully for ${appId}, sending new credentials`)
            // Get the updated credentials and send to MCA
            const credentials = await authManager.get(app.ownerId, appId)
            if (credentials) {
              const credentialsRecord: Record<string, string> = {}
              for (const [key, value] of Object.entries(credentials)) {
                if (value !== undefined && value !== null) {
                  credentialsRecord[key] = String(value)
                }
              }
              mcaConnectionManager?.sendCredentialsUpdate(appId, credentialsRecord)
              mcaManager.updateHealthFromWebSocket(appId, "ready", [])
              return
            }
          } else {
            console.warn(`[Main] Token refresh failed for ${appId}: ${refreshResult.error}`)
          }
        }
      } catch (error) {
        console.error(`[Main] Error refreshing token for ${appId}:`, error)
      }

      // Refresh failed - mark as not ready
      mcaManager.updateHealthFromWebSocket(appId, "not_ready", [
        {
          code: "AUTH_EXPIRED",
          message: reason,
        },
      ])
    })

    console.log("🔌 MCA Connection Manager initialized (WebSocket on /mca)")
  }

  // -------------------------------------------------------------------------
  // WEBSOCKET UPGRADE HANDLER (route to correct WebSocket server by path)
  // -------------------------------------------------------------------------

  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "", `http://${request.headers.host}`).pathname
    const url = new URL(request.url || "", `http://${request.headers.host}`)

    if (pathname === "/ws") {
      // Client WebSocket connections
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request)
      })
    } else if (pathname === "/voice") {
      // Voice WebSocket connections (ElevenLabs Conversational AI)
      const sessionId = url.searchParams.get("sessionId")
      const agentId = url.searchParams.get("agentId")
      const existingChannelId = url.searchParams.get("channelId") || undefined

      if (!sessionId || !agentId) {
        console.warn("[WebSocket] Voice connection missing sessionId or agentId")
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n")
        socket.destroy()
        return
      }

      // Create WebSocket
      const wssVoice = new WebSocketServer({ noServer: true })
      wssVoice.handleUpgrade(request, socket, head, (ws) => {
        // Handle connection with VoiceHandler (optionally resuming an existing channel)
        voiceHandler.handleConnection(ws, sessionId, agentId, existingChannelId).catch((error) => {
          console.error("[WebSocket] Voice connection error:", error)
          ws.close()
        })
      })
    } else if (pathname === "/mca" && mcaConnectionManager) {
      // MCA WebSocket connections
      mcaConnectionManager.handleUpgrade(request, socket, head)
    } else {
      // Unknown path - destroy socket
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
    schedulerService.start()

    const stats = await schedulerService.getStats()
    console.log(
      `📅 Scheduler: ${stats.pendingReminders} pending reminders, ${stats.enabledTasks} recurring tasks`,
    )
  } catch (error) {
    console.error(
      "📅 Scheduler service failed to start:",
      error instanceof Error ? error.message : error,
    )
  }

  // -------------------------------------------------------------------------
  // PRIVATE CHANNELS CLEANUP JOB
  // -------------------------------------------------------------------------

  // Cleanup expired private channels every hour (15 days of inactivity)
  const privateChannelCleanupInterval = setInterval(
    async () => {
      try {
        const deletedCount = await channelManager.cleanupExpiredPrivateChannels()
        if (deletedCount > 0) {
          console.log(`🧹 Private channels cleanup: ${deletedCount} expired channels deleted`)
        }
      } catch (error) {
        console.error("🧹 Private channels cleanup failed:", error)
      }
    },
    60 * 60 * 1000,
  ) // Every hour

  // Run cleanup once on startup (after a short delay)
  setTimeout(async () => {
    try {
      await channelManager.cleanupExpiredPrivateChannels()
    } catch (error) {
      console.error("🧹 Initial private channels cleanup failed:", error)
    }
  }, 10000) // 10 seconds after startup

  // -------------------------------------------------------------------------
  // START SERVER
  // -------------------------------------------------------------------------

  if (secretsManager.hasSystem("admin")) {
    console.log("Admin API: enabled (key from .secrets/system/admin.json)")
  } else {
    console.log("Admin API: disabled (no .secrets/system/admin.json)")
  }

  httpServer.listen(config.server.port, () => {
    console.log(`Server listening on port ${config.server.port}`)
    console.log(`  WebSocket: ws://localhost:${config.server.port}/ws`)
    console.log(`  Health: http://localhost:${config.server.port}/health`)
    if (secretsManager.hasSystem("admin")) {
      console.log(`  Admin: http://localhost:${config.server.port}/admin/*`)
    }
  })

  // -------------------------------------------------------------------------
  // MCA BOOT SYNC (background, non-blocking)
  // -------------------------------------------------------------------------
  // Compares tools.json on disk with mca_catalog in MongoDB.
  // Updates catalog + propagates tool changes to apps if anything changed.
  // Runs in background — server is already available when this starts.

  if (config.mca.basePath) {
    const mcasDir = resolve(config.mca.basePath);
    runMcaBootSync(db, mcasDir, mcaService, mcaManager);
    console.log('🔄 MCA boot sync scheduled (background)');
  }

  // -------------------------------------------------------------------------
  // RESUME SERVICE
  // -------------------------------------------------------------------------

  ResumeService.startWithDelay(db, eventHandler, channelManager)
    .then(() => console.log("🔄 Resume service initialized"))
    .catch((error) => console.error("🔄 Resume service failed:", error))

  // -------------------------------------------------------------------------
  // GRACEFUL SHUTDOWN
  // -------------------------------------------------------------------------

  const gracefulShutdown = async (signal: string) => {
    console.log(`\n${signal} received - shutting down gracefully...`)

    schedulerService?.stop()
    clearInterval(privateChannelCleanupInterval)

    // Cleanup voice connections
    voiceHandler.cleanupAll()

    // Shutdown MCA Connection Manager first (closes WebSocket connections to MCAs)
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

    console.log("Goodbye!")
    process.exit(0)
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"))
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
}

main().catch(async (error) => {
  console.error("Fatal error:", error)
  captureException(error, { context: "main" })
  await flushSentry(2000)
  process.exit(1)
})

// Global unhandled rejection handler
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason)
  captureException(reason instanceof Error ? reason : new Error(String(reason)), {
    context: "unhandledRejection",
  })
})

// Global uncaught exception handler
process.on("uncaughtException", async (error) => {
  console.error("Uncaught Exception:", error)
  captureException(error, { context: "uncaughtException" })
  await flushSentry(2000)
  process.exit(1)
})
