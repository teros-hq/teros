/**
 * workspace.install-app — Install an MCA app into a workspace
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { McaService } from '../../../services/mca-service'

interface InstallWorkspaceAppData {
  workspaceId: string
  mcaId: string
  name?: string
  mountPath?: string
}

export function createInstallWorkspaceAppHandler(
  workspaceService: WorkspaceService,
  mcaService: McaService,
) {
  return async function installWorkspaceApp(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as InstallWorkspaceAppData

    if (!data.workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }

    if (!data.mcaId) {
      throw new HandlerError('MISSING_MCA_ID', 'mcaId is required')
    }

    let app: any
    try {
      app = await mcaService.createWorkspaceApp(
        data.workspaceId,
        data.mcaId,
        data.name || '',
        ctx.userId,
        { mountPath: data.mountPath },
      )
    } catch (error: any) {
      if (error.message?.includes('Permission denied')) {
        throw new HandlerError('PERMISSION_DENIED', error.message)
      }
      if (error.message?.includes('not found')) {
        throw new HandlerError('NOT_FOUND', error.message)
      }
      throw error
    }

    const mca = await mcaService.getMcaFromCatalog(data.mcaId)

    console.log(`[workspace.install-app] Installed app ${app.appId} in workspace ${data.workspaceId}`)

    return {
      workspaceId: data.workspaceId,
      app: {
        appId: app.appId,
        name: app.name,
        mcaId: app.mcaId,
        mcaName: mca?.name || app.mcaId,
        description: mca?.description || '',
        icon: mca?.icon,
        category: mca?.category || 'other',
        status: app.status,
        volumes: app.volumes,
      },
    }
  }
}
