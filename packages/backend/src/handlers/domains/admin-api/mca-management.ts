/**
 * admin-api.mca — Running MCA process management (admin)
 *
 * Actions:
 *   admin-api.mca-status   → GET  /admin/mca/status
 *   admin-api.mca-kill     → POST /admin/mca/:id/kill  (formerly DELETE)
 *   admin-api.mca-cleanup  → POST /admin/mca/cleanup
 *   admin-api.mca-health   → POST /admin/mca/health
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import type { McaManager } from "../../../services/mca-manager"
import type { McaService } from "../../../services/mca-service"
import { HandlerError } from "../../../ws-framework/WsRouter"

async function requireAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection("users").findOne({ userId })
  if (user?.role !== "admin" && user?.role !== "super") {
    throw new HandlerError("FORBIDDEN", "Admin privileges required")
  }
}

function requireMcaManager(mcaManager: McaManager | null | undefined): McaManager {
  if (!mcaManager) throw new HandlerError("SERVICE_UNAVAILABLE", "MCA Manager not available")
  return mcaManager
}

export function createMcaStatusHandler(
  db: Db,
  mcaManager: McaManager | null,
  mcaService: McaService,
) {
  return async function mcaStatus(ctx: WsHandlerContext, _rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const mgr = requireMcaManager(mcaManager)

    const status = mgr.getStatus()

    const enrichedStatus = await Promise.all(
      status.map(async (mca) => {
        const app = await mcaService.getApp(mca.appId)
        const catalog = app ? await mcaService.getMcaFromCatalog(app.mcaId) : null
        return {
          ...mca,
          appName: app?.name ?? "Unknown",
          mcaName: catalog?.name ?? "Unknown",
          ownerId: app?.ownerId ?? "Unknown",
          idleTimeMs: Date.now() - mca.lastUsed.getTime(),
        }
      }),
    )

    return {
      mcas: enrichedStatus,
      summary: {
        total: status.length,
        ready: status.filter((m) => m.status === "ready").length,
        starting: status.filter((m) => m.status === "starting").length,
        error: status.filter((m) => m.status === "error").length,
      },
    }
  }
}

export function createMcaKillHandler(db: Db, mcaManager: McaManager | null) {
  return async function mcaKill(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const mgr = requireMcaManager(mcaManager)
    const data = rawData as { appId: string }
    if (!data.appId) throw new HandlerError("VALIDATION_ERROR", "appId is required")

    await mgr.kill(data.appId)
    return { success: true, appId: data.appId }
  }
}

export function createMcaCleanupHandler(db: Db, mcaManager: McaManager | null) {
  return async function mcaCleanup(ctx: WsHandlerContext, _rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const mgr = requireMcaManager(mcaManager)

    const cleaned = await mgr.cleanupInactive()
    return { cleaned, count: cleaned.length }
  }
}

export function createMcaHealthHandler(
  db: Db,
  mcaManager: McaManager | null,
  mcaService: McaService,
) {
  return async function mcaHealth(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const mgr = requireMcaManager(mcaManager)
    const data = (rawData ?? {}) as { forceSpawn?: boolean }

    const results = await mgr.checkAllHealth(data.forceSpawn === true)

    const healthResults = await Promise.all(
      Array.from(results.entries()).map(async ([appId, health]) => {
        const app = await mcaService.getApp(appId)
        return {
          appId,
          appName: app?.name ?? "Unknown",
          mcaId: app?.mcaId ?? "Unknown",
          health,
        }
      }),
    )

    const summary = {
      total: healthResults.length,
      healthy: healthResults.filter((r) => r.health.status === "healthy").length,
      unhealthy: healthResults.filter((r) => r.health.status === "unhealthy").length,
      degraded: healthResults.filter((r) => r.health.status === "degraded").length,
      unknown: healthResults.filter((r) => r.health.status === "unknown").length,
    }

    return { mcas: healthResults, summary }
  }
}
