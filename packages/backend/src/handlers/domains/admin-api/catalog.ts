/**
 * admin-api.catalog — MCA Catalog (admin)
 *
 * Actions:
 *   admin-api.catalog-list → GET /admin/catalog
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import type { McaService } from "../../../services/mca-service"
import { HandlerError } from "../../../ws-framework/WsRouter"

async function requireAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection("users").findOne({ userId })
  if (user?.role !== "admin" && user?.role !== "super") {
    throw new HandlerError("FORBIDDEN", "Admin privileges required")
  }
}

export function createCatalogListHandler(db: Db, mcaService: McaService) {
  return async function catalogList(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as { category?: string; includeHidden?: boolean }

    let catalog = await mcaService.listCatalog("active")

    if (data.category) {
      catalog = catalog.filter((mca) => mca.category === data.category)
    }

    if (!data.includeHidden) {
      catalog = catalog.filter((mca) => !mca.availability?.hidden)
    }

    return { catalog }
  }
}
