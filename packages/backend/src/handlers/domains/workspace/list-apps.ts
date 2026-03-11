/**
 * workspace.list-apps — List apps installed in a workspace
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { McaService } from '../../../services/mca-service'

interface ListWorkspaceAppsData {
  workspaceId: string
}

export function createListWorkspaceAppsHandler(
  workspaceService: WorkspaceService,
  mcaService: McaService,
) {
  return async function listWorkspaceApps(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListWorkspaceAppsData

    if (!data.workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }

    if (!(await workspaceService.canAccess(data.workspaceId, ctx.userId))) {
      throw new HandlerError('ACCESS_DENIED', 'You do not have access to this workspace')
    }

    const apps = await mcaService.listWorkspaceApps(data.workspaceId)

    const appsWithInfo = await Promise.all(
      apps.map(async (app) => {
        const mca = await mcaService.getMcaFromCatalog(app.mcaId)
        return {
          appId: app.appId,
          name: app.name,
          mcaId: app.mcaId,
          mcaName: mca?.name || app.mcaId,
          description: mca?.description || '',
          icon: mca?.icon,
          color: mca?.color,
          category: mca?.category || 'other',
          status: app.status,
          volumes: app.volumes,
        }
      }),
    )

    return { workspaceId: data.workspaceId, apps: appsWithInfo }
  }
}
