/**
 * Admin Routes — HTTP fallback
 *
 * ⚠️  This file contains ONLY the POST /admin/restart endpoint.
 *
 * ALL other /admin/* routes have been migrated to the WsRouter as the
 * `admin-api` domain. See: handlers/domains/admin-api/
 *
 * Reason for the exception: POST /admin/restart causes the backend to restart.
 * If the WebSocket drops during the process (likely), the WS channel would become
 * unusable. HTTP is the only reliable channel as an emergency fallback.
 *
 * Authentication: Bearer {sessionToken} (admin/super) or Bearer {ADMIN_API_KEY}
 */

import { createHash } from "crypto"
import type { IncomingMessage, ServerResponse } from "http"
import type { Db } from "mongodb"
import type { SecretsManager } from "../secrets/secrets-manager"

export interface AdminRoutesConfig {
  db: Db
  secretsManager: SecretsManager
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

  const token = authHeader.slice(7)

  // Method 1: admin API key from secrets
  const adminSecret = secretsManager.system("admin")
  if (adminSecret?.apiKey && token === adminSecret.apiKey) return true

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

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

/**
 * Create admin HTTP routes handler.
 * Only handles POST /admin/restart — all other routes migrated to WsRouter.
 */
export function createAdminRoutes(cfg: AdminRoutesConfig) {
  const { db, secretsManager } = cfg

  return async function handleAdminRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<boolean> {
    const basePath = url.indexOf("?") === -1 ? url : url.slice(0, url.indexOf("?"))

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return true
    }

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
      }, 100)

      return true
    }

    return false // Not handled here — all other /admin/* routes are in WsRouter
  }
}
