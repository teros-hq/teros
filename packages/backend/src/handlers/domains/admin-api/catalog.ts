/**
 * admin-api.catalog — MCA Catalog (admin)
 *
 * Actions:
 *   admin-api.catalog-list → GET /admin/catalog
 *     Lightweight summaries for browsing (name, category, counts, keywords).
 *     Full entry documents are NOT returned here — use catalog-get for detail.
 *   admin-api.catalog-get  → detail for a single MCA (full entry incl. tools).
 *
 * Context (2026-11-04, Pablo): the old catalog-list returned every full catalog
 * entry (all tool names + toolsDetailed), which blew up the agent's context.
 * The list is now a compact summary; agents fetch detail per-MCA on demand.
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import type { McaService } from "../../../services/mca-service"
import type { McpCatalogEntry } from "../../../types/database"
import { HandlerError } from "../../../ws-framework/WsRouter"

async function requireAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection("users").findOne({ userId })
  if (user?.role !== "admin" && user?.role !== "super") {
    throw new HandlerError("FORBIDDEN", "Admin privileges required")
  }
}

/** Compact summary of a catalog entry — light enough for a full listing. */
function toSummary(mca: McpCatalogEntry) {
  return {
    mcaId: mca.mcaId,
    name: mca.name,
    description: mca.description,
    tagline: mca.tagline ?? null,
    category: mca.category,
    icon: mca.icon ?? null,
    color: mca.color ?? null,
    version: mca.version ?? null,
    verified: mca.verified ?? false,
    keywords: mca.keywords ?? [],
    toolCount: mca.tools?.length ?? 0,
    authType: mca.auth?.type ?? "none",
    availability: {
      enabled: mca.availability?.enabled ?? true,
      multi: mca.availability?.multi ?? false,
      system: mca.availability?.system ?? false,
      hidden: mca.availability?.hidden ?? false,
      role: mca.availability?.role ?? "user",
    },
  }
}

/** Case-insensitive substring match across the fields an admin would search. */
function matchesQuery(mca: McpCatalogEntry, query: string): boolean {
  const q = query.toLowerCase()
  const haystacks: string[] = [
    mca.mcaId,
    mca.name,
    mca.description,
    mca.tagline ?? "",
    mca.category ?? "",
    ...(mca.keywords ?? []),
    ...(mca.tools ?? []),
  ]
  return haystacks.some((field) => field?.toLowerCase().includes(q))
}

export function createCatalogListHandler(db: Db, mcaService: McaService) {
  return async function catalogList(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as {
      category?: string
      search?: string
      includeHidden?: boolean
    }

    let catalog = await mcaService.listCatalog("active")

    if (data.category) {
      catalog = catalog.filter((mca) => mca.category === data.category)
    }

    if (!data.includeHidden) {
      catalog = catalog.filter((mca) => !mca.availability?.hidden)
    }

    if (data.search && data.search.trim()) {
      catalog = catalog.filter((mca) => matchesQuery(mca, data.search!.trim()))
    }

    return { catalog: catalog.map(toSummary) }
  }
}

export function createCatalogGetHandler(db: Db, mcaService: McaService) {
  return async function catalogGet(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as { mcaId?: string }
    if (!data.mcaId || typeof data.mcaId !== "string") {
      throw new HandlerError("MISSING_MCA_ID", "mcaId is required")
    }

    const mca = await mcaService.getMcaFromCatalog(data.mcaId)
    if (!mca) {
      throw new HandlerError("MCA_NOT_FOUND", `MCA ${data.mcaId} not found`)
    }

    return { mca }
  }
}
