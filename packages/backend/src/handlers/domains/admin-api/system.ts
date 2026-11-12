/**
 * admin-api.system — Backend status and operations (admin)
 *
 * Actions:
 *   admin-api.system-status → GET  /admin/status
 *   admin-api.system-sync   → POST /admin/sync
 *   admin-api.system-active-sessions → GET /admin/active-sessions
 *   admin-api.system-refresh-clients → POST /admin/refresh-clients
 *
 * ⚠️  EXCEPTION: POST /admin/restart remains as HTTP.
 *     Reason: if the WebSocket drops (e.g. during a restart), the endpoint
 *     must be reachable via HTTP as an emergency fallback.
 *     See admin-routes.ts → POST /admin/restart (only endpoint that remains).
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import type { McaManager } from "../../../services/mca-manager"
import type { PubSubService } from "../../../services/pubsub-service"
import type { SessionManager } from "../../../services/session-manager"
import { HandlerError } from "../../../ws-framework/WsRouter"
import { auditPortOwnership } from "../../../lib/port-ownership"

async function requireAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection("users").findOne({ userId })
  if (user?.role !== "admin" && user?.role !== "super") {
    throw new HandlerError("FORBIDDEN", "Admin privileges required")
  }
}

export function createSystemStatusHandler(db: Db, mcaManager: McaManager | null) {
  return async function systemStatus(ctx: WsHandlerContext, _rawData: unknown) {
    await requireAdmin(db, ctx.userId)

    // Port ownership (incident 2026-11-01 08:40): backend-status used to
    // report only process.pid — which is the tsx child, fine in the normal
    // case, but it said NOTHING about whether that pid actually holds the
    // listen socket. When an orphan stole the port, status looked healthy.
    // Now the status answers: who holds :PORT, is it ours (pm2 descent +
    // env markers), and which git commit does it serve. Degrades to nulls
    // (never throws) so status stays usable even when /proc is partial.
    const port = Number(process.env.PORT) || 10001
    const appName = process.env.name || "teros-backend"
    let portOwnership: Awaited<ReturnType<typeof auditPortOwnership>> | null = null
    try {
      portOwnership = await auditPortOwnership({ port, appName })
    } catch (error) {
      console.error("[admin-api.system-status] port ownership audit failed:", error)
    }

    return {
      status: "running",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      mcaCount: mcaManager?.getStatus().length ?? 0,
      // Real listener on the backend port — the pid that actually serves
      // traffic, with the ownership verdict (see lib/port-ownership.ts).
      listener: portOwnership
        ? {
            port: portOwnership.port,
            pid: portOwnership.listenerPids[0] ?? null,
            isSelf: portOwnership.listenerPids[0] === process.pid,
            descendsFromPm2: portOwnership.listenerDescendsFromPm2,
            hasPm2Env: portOwnership.listenerHasPm2Env,
            pm2WrapperPid: portOwnership.pm2WrapperPid,
            ok: portOwnership.ok,
            reason: portOwnership.reason,
            checkout: portOwnership.checkout,
          }
        : null,
      portOwnership,
      timestamp: new Date().toISOString(),
    }
  }
}

export function createSystemSyncHandler(db: Db) {
  return async function systemSync(ctx: WsHandlerContext, _rawData: unknown) {
    await requireAdmin(db, ctx.userId)

    console.log("🔄 Sync requested via admin-api WsRouter")

    const { runSync } = await import("../../../sync")
    const startTime = Date.now()

    await runSync()

    const duration = ((Date.now() - startTime) / 1000).toFixed(1)

    return {
      success: true,
      message: "Sync completed successfully",
      duration: `${duration}s`,
      timestamp: new Date().toISOString(),
    }
  }
}

/**
 * admin-api.system-active-sessions — List active WebSocket connections
 *
 * Returns all active sessions from the in-memory SessionManager, including
 * userId, connection time, last activity time, and IP address.
 * Used by the admin Activity Ads panel to show who is online in real time.
 */
export function createSystemActiveSessionsHandler(
  db: Db,
  sessionManager: SessionManager | null,
) {
  return async function systemActiveSessions(ctx: WsHandlerContext, _rawData: unknown) {
    await requireAdmin(db, ctx.userId)

    if (!sessionManager) {
      return {
        totalConnections: 0,
        uniqueUsers: 0,
        sessions: [],
        note: "SessionManager not available",
      }
    }

    const allSessions = sessionManager.getAllActiveSessions()

    // Enrich with user info from DB
    const userIds = [...new Set(allSessions.map(s => s.userId))]
    const users = await db.collection("users")
      .find({ userId: { $in: userIds } })
      .project({ userId: 1, "profile.name": 1, "profile.email": 1, "profile.avatarUrl": 1 })
      .toArray()

    const userMap = new Map(users.map(u => [u.userId, u]))

    const sessions = allSessions.map(s => {
      const user = userMap.get(s.userId)
      const secondsSincePing = Math.floor((Date.now() - s.lastPingAt.getTime()) / 1000)
      // Client pings every 30s; >90s without ping = socket is dead in practice
      // (app closed without a close frame) even if TCP hasn't noticed yet.
      const alive = secondsSincePing <= 90
      return {
        sessionId: s.sessionId,
        userId: s.userId,
        userName: user?.profile?.name ?? null,
        userEmail: user?.profile?.email ?? null,
        userAvatar: user?.profile?.avatarUrl ?? null,
        connectedAt: s.connectedAt,
        lastActivityAt: s.lastActivityAt,
        lastPingAt: s.lastPingAt,
        idleSeconds: Math.floor((Date.now() - s.lastActivityAt.getTime()) / 1000),
        connectionDurationSeconds: Math.floor((Date.now() - s.connectedAt.getTime()) / 1000),
        ip: s.ip,
        userAgent: s.userAgent,
        platform: parsePlatform(s.userAgent),
        secondsSincePing,
        alive,
      }
    })

    // Sort by last activity (most recent first)
    sessions.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())

    return {
      totalConnections: sessions.length,
      uniqueUsers: userIds.length,
      aliveConnections: sessions.filter(s => s.alive).length,
      zombieConnections: sessions.filter(s => !s.alive).length,
      sessions,
      timestamp: new Date().toISOString(),
    }
  }
}

/**
 * admin-api.system-refresh-clients — Broadcast a refresh signal to connected clients
 *
 * Sends `{ type: 'event', event: 'client.refresh', data }` over WebSocket to
 * every connected client (all devices of all users) — or, when `userId` is
 * passed, only to that user's sessions. The client reacts with a graceful,
 * staggered reload (random jitter within `maxDelayMs`) so a deploy-finished
 * broadcast doesn't thundering-herd nginx/backend with simultaneous reloads.
 *
 * Admin-only (requireAdmin). Returns how many sessions the signal reached so
 * the admin surface can report it ("N clientes alcanzados").
 *
 * Params:
 *   - reason (optional, string): why — 'deploy' | 'admin' | custom label.
 *     Shipped to the client for display/logging. Defaults to 'admin'.
 *   - userId (optional, string): refresh only this user's sessions
 *     (the per-user variant from the active-sessions list).
 *   - maxDelayMs (optional, number): stagger window the client should respect.
 *     Defaults to 30000 (0-30s jitter). Clamped to 0..300000.
 */
export function createSystemRefreshClientsHandler(
  db: Db,
  sessionManager: SessionManager | null,
  pubSubService: PubSubService | null,
) {
  return async function systemRefreshClients(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)

    const data = (rawData && typeof rawData === "object" ? rawData : {}) as Record<string, unknown>
    const reason = typeof data.reason === "string" && data.reason.trim() ? data.reason.trim() : "admin"
    const targetUserId = typeof data.userId === "string" && data.userId.trim() ? data.userId.trim() : null
    let maxDelayMs = typeof data.maxDelayMs === "number" ? data.maxDelayMs : 30_000
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) maxDelayMs = 30_000
    maxDelayMs = Math.min(maxDelayMs, 300_000)

    const event = {
      type: "event",
      event: "client.refresh",
      data: {
        reason,
        maxDelayMs,
        issuedAt: new Date().toISOString(),
      },
    }

    if (!pubSubService) {
      throw new HandlerError("SERVICE_UNAVAILABLE", "PubSubService not available")
    }

    let sent: number
    if (targetUserId) {
      // Per-user variant: only that user's sessions (all their devices).
      // Reuses broadcastToUser so the payload shape is identical.
      pubSubService.broadcastToUser(targetUserId, event)
      sent = sessionManager?.getUserSessions(targetUserId).filter(
        (s) => s.ws.readyState === 1,
      ).length ?? 0
    } else {
      sent = pubSubService.broadcastToAllSessions(event)
    }

    const totalConnections = sessionManager?.getConnectionCount() ?? sent
    const uniqueUsers = sessionManager
      ? new Set(sessionManager.getAllActiveSessions().map((s) => s.userId)).size
      : 0

    console.log(
      `🔄 [admin-api.system-refresh-clients] reason=${reason}${targetUserId ? ` user=${targetUserId}` : " (all)"} — signal sent to ${sent}/${totalConnections} session(s)`,
    )

    return {
      success: true,
      sent,
      totalConnections,
      uniqueUsers,
      scope: targetUserId ? "user" : "all",
      reason,
      maxDelayMs,
      timestamp: new Date().toISOString(),
    }
  }
}

/**
 * Coarse platform classification from a raw User-Agent header.
 * "unknown" for raw WS clients (MCAs, scripts) that send no UA.
 */
function parsePlatform(userAgent: string | null): string {
  if (!userAgent) return "unknown"
  const ua = userAgent.toLowerCase()
  if (ua.includes("teros") && (ua.includes("desktop") || ua.includes("electron"))) return "desktop"
  if (ua.includes("electron")) return "desktop"
  if (ua.includes("expo") || ua.includes("okhttp") || ua.includes("react-native")) return "mobile"
  if (ua.includes("android")) return "mobile"
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ios")) return "mobile"
  if (ua.includes("mozilla") || ua.includes("chrome") || ua.includes("safari") || ua.includes("edge") || ua.includes("firefox")) return "web"
  return "other"
}
