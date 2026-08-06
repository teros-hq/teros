/**
 * app.get-mca-health — Read the whole MCA tool-health fleet (admin)
 *
 * Returns a flat array of per-(mcaId, tool) health rows (D-02); the dashboard
 * left-joins by (mcaId, tool) and derives `overall` itself (no server-side
 * grouping). `testedAt` is stored as a Mongo Date and serialized to ISO on read
 * (D-05). Admin-gated via requireSystemAdmin (SC2).
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import { requireSystemAdmin } from "../../../auth/auth-helpers"
import type { McaToolHealth } from "../../../types/database"

export function createGetMcaHealthHandler(db: Db) {
  return async function getMcaHealth(ctx: WsHandlerContext, _rawData: unknown) {
    // Admin-only: whole-fleet health is global catalog state (SC2, T-05-04).
    await requireSystemAdmin(db, ctx.userId)

    const rows = await db.collection<McaToolHealth>("mca_tool_health").find({}).toArray()

    // D-02: flat array of { mcaId, tool, status, testedAt, error? }.
    // D-05: testedAt stored as Date → serialize to ISO string on read.
    // Read-boundary guard: a row missing testedAt (manual edit, partial writer)
    // must degrade to that one row lacking a timestamp — an unguarded
    // .toISOString() would reject the whole fleet read and blank the dashboard.
    const health = rows.map((r) => ({
      mcaId: r.mcaId,
      tool: r.tool,
      status: r.status,
      ...(r.testedAt instanceof Date ? { testedAt: r.testedAt.toISOString() } : {}),
      ...(r.error ? { error: r.error } : {}),
    }))

    return { health }
  }
}
