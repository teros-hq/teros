/**
 * admin-api.system — Backend status and operations (admin)
 *
 * Actions:
 *   admin-api.system-status → GET  /admin/status
 *   admin-api.system-sync   → POST /admin/sync
 *
 * ⚠️  EXCEPTION: POST /admin/restart remains as HTTP.
 *     Reason: if the WebSocket drops (e.g. during a restart), the endpoint
 *     must be reachable via HTTP as an emergency fallback.
 *     See admin-routes.ts → POST /admin/restart (only endpoint that remains).
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import type { McaManager } from "../../../services/mca-manager"
import { HandlerError } from "../../../ws-framework/WsRouter"

async function requireAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection("users").findOne({ userId })
  if (user?.role !== "admin" && user?.role !== "super") {
    throw new HandlerError("FORBIDDEN", "Admin privileges required")
  }
}

export function createSystemStatusHandler(db: Db, mcaManager: McaManager | null) {
  return async function systemStatus(ctx: WsHandlerContext, _rawData: unknown) {
    await requireAdmin(db, ctx.userId)

    return {
      status: "running",
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      mcaCount: mcaManager?.getStatus().length ?? 0,
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
