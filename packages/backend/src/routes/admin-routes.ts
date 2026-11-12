/**
 * Admin Routes — HTTP fallback
 *
 * ⚠️  This file contains ONLY four endpoints:
 *   - POST /admin/restart
 *   - GET  /admin/port-ownership
 *   - POST /admin/kill-foreign-port
 *   - POST /admin/refresh-clients
 *
 * ALL other /admin/* routes have been migrated to the WsRouter as the
 * `admin-api` domain. See: handlers/domains/admin-api/
 *
 * Reason for the exceptions:
 *   - POST /admin/restart causes the backend to restart. If the WebSocket
 *     drops during the process (likely), the WS channel would become
 *     unusable. HTTP is the only reliable channel as an emergency fallback.
 *   - GET /admin/port-ownership and POST /admin/kill-foreign-port must be
 *     reachable exactly when the WS layer is DOWN: mid-restart, or while the
 *     pm2 process is crash-looping on EADDRINUSE because an orphan from a
 *     previous restart still holds the port (incident 2026-11-01 08:40).
 *   - POST /admin/refresh-clients is the deploy-pipeline webhook: GitHub
 *     Actions (or Pablo manually) POSTs it with the admin API key when a
 *     deploy finishes, so every connected browser reloads to the new
 *     version. It lives here (not in the WS admin-api domain) because the
 *     caller is a machine with a Bearer secret, not a logged-in user with a
 *     live WS session. The same broadcast is also available as the WS
 *     action `admin-api.system-refresh-clients` for the admin panel/MCA.
 *
 * Authentication: Bearer {sessionToken} (admin/super) or Bearer {ADMIN_API_KEY}
 */

import { createHash, timingSafeEqual } from "crypto"
import type { IncomingMessage, ServerResponse } from "http"
import type { Db } from "mongodb"
import type { SecretsManager } from "../secrets/secrets-manager"
import type { PubSubService } from "../services/pubsub-service"
import type { SessionManager } from "../services/session-manager"
import { auditPortOwnership, killForeignPortHolders } from "../lib/port-ownership"

export interface AdminRoutesConfig {
  db: Db
  secretsManager: SecretsManager
  /** Broadcast layer for POST /admin/refresh-clients. Optional for tests. */
  pubSubService?: PubSubService | null
  /** Session registry for connection counts in the refresh response. Optional. */
  sessionManager?: SessionManager | null
  /** Local port the backend listens on — used by the port-ownership audit
   * routes. Defaults to Number(process.env.PORT) || 10001. */
  port?: number
  /** pm2 app name expected to own the port ("teros-backend"). Defaults to
   * process.env.name (injected by pm2) || "teros-backend". */
  appName?: string
}

/**
 * Hash a token for lookup (same algorithm as session-service)
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * Verify admin authentication from request headers.
 */
async function verifyAdminAuth(
  req: IncomingMessage,
  db: Db,
  secretsManager: SecretsManager,
): Promise<boolean> {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith("Bearer ")) return false

  // Validate that a non-empty token follows the "Bearer " prefix
  const token = authHeader.slice(7).trim()
  if (!token) return false

  // Method 1: admin API key from secrets — use timingSafeEqual to prevent timing attacks
  const adminSecret = secretsManager.system("admin")
  if (adminSecret?.apiKey) {
    try {
      const providedBuf = Buffer.from(token)
      const expectedBuf = Buffer.from(adminSecret.apiKey)
      // Buffers must be the same length for timingSafeEqual — if lengths differ, reject immediately
      // (length difference is not secret information, so this is safe)
      if (providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf)) {
        return true
      }
    } catch {
      // timingSafeEqual can throw if buffers are invalid — treat as auth failure
      return false
    }
  }

  // Method 2: valid user session token for admin/super user
  try {
    const sessionsCollection = db.collection("user_sessions")
    const usersCollection = db.collection("users")

    const tokenHash = hashToken(token)
    const session = await sessionsCollection.findOne({
      tokenHash,
      status: "active",
      expiresAt: { $gt: new Date() },
    })
    if (!session) return false

    const user = await usersCollection.findOne({ userId: session.userId })
    if (!user) return false

    return user.role === "admin" || user.role === "super"
  } catch (error) {
    console.error("[Admin] Error verifying session token:", error)
    return false
  }
}

/**
 * Delay between answering POST /admin/restart and sending SIGTERM.
 *
 * The permission flow ends the agent's turn BEFORE the restart tool runs. With
 * a 100ms delay the backend died before the tool result reached the
 * conversation and started the continuation turn, leaving the channel with
 * running=false, so the resume-service did not rescue the conversation.
 * With 10s: result delivered -> turn starts -> setRunning(true) -> backend
 * dies -> boot scan finds running=true -> system_resume wakes the agent.
 * See incident 2026-11-02 (3 occurrences).
 *
 * Margin: 10s < watchdog shutdown 25s < pm2 kill_timeout 30s — no overlap.
 */
const RESTART_DELAY_MS = 10_000

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

/**
 * Create admin HTTP routes handler.
 * Only handles POST /admin/restart — all other routes migrated to WsRouter.
 */
export function createAdminRoutes(cfg: AdminRoutesConfig) {
  const { db, secretsManager, pubSubService, sessionManager } = cfg

  return async function handleAdminRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<boolean> {
    const basePath = url.indexOf("?") === -1 ? url : url.slice(0, url.indexOf("?"))

    // OPTIONS preflight is handled by the main HTTP handler in http-server.ts
    // (lines 254-258). CORS headers are set there via resolveAllowedOrigin().

    // POST /admin/restart — HTTP fallback (WS may be unavailable during restart)
    if (basePath === "/admin/restart" && req.method === "POST") {
      if (!(await verifyAdminAuth(req, db, secretsManager))) {
        sendJson(res, 401, { error: "Unauthorized", message: "Invalid or missing credentials" })
        return true
      }

      console.log("🔄 Backend restart requested via HTTP admin API")

      sendJson(res, 200, {
        success: true,
        message: "Backend restart initiated",
        timestamp: new Date().toISOString(),
      })

      setTimeout(() => {
        console.log("🔄 Initiating graceful restart...")
        process.kill(process.pid, "SIGTERM")
      }, RESTART_DELAY_MS)

      return true
    }

    // GET /admin/port-ownership — who really holds the backend port.
    //
    // Incident 2026-11-01 08:40: after a restart, an ORPHAN node process
    // outside the pm2 tree held :10001 serving stale code for ~20 min while
    // backend-status happily reported its pid. This endpoint answers, from
    // the host: which pid holds the listen socket, whether it descends from
    // the current pm2 wrapper (pidfile + env markers), and the git commit of
    // the checkout it serves. HTTP (not WS) so it works during a restart when
    // the WS layer is down — same rationale as POST /admin/restart.
    if (basePath === "/admin/port-ownership" && req.method === "GET") {
      if (!(await verifyAdminAuth(req, db, secretsManager))) {
        sendJson(res, 401, { error: "Unauthorized", message: "Invalid or missing credentials" })
        return true
      }

      const ownership = await auditPortOwnership({
        port: cfg.port ?? (Number(process.env.PORT) || 10001),
        appName: cfg.appName ?? (process.env.name || 'teros-backend'),
      })

      sendJson(res, 200, {
        success: true,
        ...ownership,
        timestamp: new Date().toISOString(),
      })
      return true
    }

    // POST /admin/kill-foreign-port — kill listeners on the backend port that
    // are NOT part of the current pm2 tree (orphans from a previous restart).
    //
    // Safety: the pm2 wrapper and ALL its descendants are never touched — if
    // the only listener is a legit pm2 descendant this is a no-op. This
    // process (the backend itself) is always excluded by construction: it
    // either descends from the wrapper (normal) or is the one being replaced
    // (restart flow). Foreign listeners get SIGTERM, then SIGKILL after 3s.
    //
    // HTTP for the same reason as /admin/restart: must be callable when the
    // WS layer is mid-restart or crash-looping on EADDRINUSE.
    if (basePath === "/admin/kill-foreign-port" && req.method === "POST") {
      if (!(await verifyAdminAuth(req, db, secretsManager))) {
        sendJson(res, 401, { error: "Unauthorized", message: "Invalid or missing credentials" })
        return true
      }

      const port = cfg.port ?? (Number(process.env.PORT) || 10001)
      const appName = cfg.appName ?? (process.env.name || 'teros-backend')

      console.log(`🔪 [POST /admin/kill-foreign-port] auditing :${port} for non-pm2 listeners`)

      const { killed, ownership } = await killForeignPortHolders({ port, appName })

      // Re-audit AFTER the kills so the response reflects the final state.
      const after = await auditPortOwnership({ port, appName })

      const message =
        killed.length === 0
          ? `no foreign listeners on :${port} — nothing killed`
          : `killed ${killed.length} foreign listener(s) on :${port}: ${killed.join(", ")}`

      console.log(`🔪 [POST /admin/kill-foreign-port] ${message}`)

      sendJson(res, 200, {
        success: true,
        message,
        killed,
        before: ownership,
        after,
        timestamp: new Date().toISOString(),
      })
      return true
    }

    // POST /admin/refresh-clients — deploy-pipeline webhook.
    // Broadcasts { event: 'client.refresh' } to every connected client so all
    // open browsers reload to the freshly deployed version (staggered by the
    // client with random jitter within maxDelayMs — no thundering herd).
    // Same broadcast as the WS action admin-api.system-refresh-clients; this
    // HTTP form exists for machine callers (GitHub Actions, curl) that hold
    // the admin API key but have no WS session.
    if (basePath === "/admin/refresh-clients" && req.method === "POST") {
      if (!(await verifyAdminAuth(req, db, secretsManager))) {
        sendJson(res, 401, { error: "Unauthorized", message: "Invalid or missing credentials" })
        return true
      }

      if (!pubSubService) {
        sendJson(res, 503, { error: "SERVICE_UNAVAILABLE", message: "PubSubService not available" })
        return true
      }

      let body: Record<string, unknown>
      try {
        body = (await readBody(req)) as Record<string, unknown>
      } catch {
        sendJson(res, 400, { error: "BAD_REQUEST", message: "Invalid JSON body" })
        return true
      }
      const params = body && typeof body === "object" && !Array.isArray(body) ? body : {}

      const reason =
        typeof params.reason === "string" && params.reason.trim() ? params.reason.trim() : "deploy"
      const targetUserId =
        typeof params.userId === "string" && params.userId.trim() ? params.userId.trim() : null
      let maxDelayMs = typeof params.maxDelayMs === "number" ? params.maxDelayMs : 30_000
      if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) maxDelayMs = 30_000
      maxDelayMs = Math.min(maxDelayMs, 300_000)

      const event = {
        type: "event",
        event: "client.refresh",
        data: { reason, maxDelayMs, issuedAt: new Date().toISOString() },
      }

      let sent: number
      if (targetUserId) {
        pubSubService.broadcastToUser(targetUserId, event)
        sent =
          sessionManager?.getUserSessions(targetUserId).filter((s) => s.ws.readyState === 1)
            .length ?? 0
      } else {
        sent = pubSubService.broadcastToAllSessions(event)
      }

      const totalConnections = sessionManager?.getConnectionCount() ?? sent
      const uniqueUsers = sessionManager
        ? new Set(sessionManager.getAllActiveSessions().map((s) => s.userId)).size
        : 0

      console.log(
        `🔄 [POST /admin/refresh-clients] reason=${reason}${targetUserId ? ` user=${targetUserId}` : " (all)"} — signal sent to ${sent}/${totalConnections} session(s)`,
      )

      sendJson(res, 200, {
        success: true,
        sent,
        totalConnections,
        uniqueUsers,
        scope: targetUserId ? "user" : "all",
        reason,
        maxDelayMs,
        timestamp: new Date().toISOString(),
      })

      return true
    }

    return false // Not handled here — all other /admin/* routes are in WsRouter
  }
}

/**
 * Read and parse a JSON request body. Empty body → {}.
 */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString()
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error("Invalid JSON body"))
      }
    })
    req.on("error", reject)
  })
}
