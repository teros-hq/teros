/**
 * app.list — List installed apps for the current user (own + system)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'

export function createListAppsHandler(mcaService: McaService) {
  return async function listApps(ctx: WsHandlerContext, _rawData: unknown) {
    const [userApps, systemApps] = await Promise.all([
      mcaService.listAppsByOwner(ctx.userId),
      mcaService.listAppsByOwner('system'),
    ])

    const allApps = [...userApps, ...systemApps]

    const appsWithInfo = await Promise.all(
      allApps.map(async (app) => {
        const mca = await mcaService.getMcaFromCatalog(app.mcaId)
        return {
          appId: app.appId,
          name: app.name,
          mcaId: app.mcaId,
          mcpName: mca?.name || app.mcaId,
          description: mca?.description || '',
          icon: mca?.icon,
          color: mca?.color,
          category: mca?.category || 'integration',
          status: app.status,
        }
      }),
    )

    return { apps: appsWithInfo }
  }
}
