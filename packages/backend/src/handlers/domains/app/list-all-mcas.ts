/**
 * app.list-all-mcas — List ALL MCAs with full data (admin, no filters)
 */

import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'

export function createListAllMcasHandler(mcaService: McaService) {
  return async function listAllMcas(_ctx: WsHandlerContext, _rawData: unknown) {
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
