/**
 * app.list-all-mcas — List ALL MCAs with full data (admin, no filters)
 */

import type { Db } from 'mongodb'
import type { WsHandlerContext } from '@teros/shared'
import { requireSystemAdmin } from '../../../auth/auth-helpers'
import type { McaService } from '../../../services/mca-service'

export function createListAllMcasHandler(mcaService: McaService, db: Db) {
  return async function listAllMcas(ctx: WsHandlerContext, _rawData: unknown) {
    // Admin-only: exposes full catalog data (hidden/role) with no filters (TER-513).
    await requireSystemAdmin(db, ctx.userId)

    const catalog = await mcaService.listCatalog()

    const mcas = catalog.map((mca) => ({
      mcaId: mca.mcaId,
      name: mca.name,
      description: mca.description,
      icon: mca.icon,
      color: mca.color,
      category: mca.category,
      tools: mca.tools,
      status: mca.status,
      availability: {
        enabled: mca.availability?.enabled ?? true,
        multi: mca.availability?.multi ?? false,
        system: mca.availability?.system ?? false,
        hidden: mca.availability?.hidden ?? false,
        role: mca.availability?.role ?? 'user',
      },
      systemSecrets: mca.systemSecrets || [],
      userSecrets: mca.userSecrets || [],
      auth: mca.auth,
    }))

    return { mcas }
  }
}
