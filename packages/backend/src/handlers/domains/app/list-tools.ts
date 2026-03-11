/**
 * app.list-tools — List available tools for an app (via McaManager)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'
import type { McaManager } from '../../../services/mca-manager'
import type { WorkspaceService } from '../../../services/workspace-service'

interface ListToolsData {
  appId: string
  requestId?: string
}

async function userHasAppAccess(
  mcaService: McaService,
  workspaceService: WorkspaceService | undefined,
  userId: string,
  appId: string,
): Promise<boolean> {
  const app = await mcaService.getApp(appId)
  if (!app) return false
  if (app.ownerId === userId) return true
  if (app.ownerType === 'workspace' && workspaceService) {
    return workspaceService.canAccess(app.ownerId, userId)
  }
  return false
}

export function createListToolsHandler(
  mcaService: McaService,
  mcaManager: McaManager | null,
  workspaceService?: WorkspaceService,
) {
  return async function listTools(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListToolsData
    const { appId, requestId } = data

    if (!appId) {
      throw new HandlerError('MISSING_APP_ID', 'appId is required')
    }
    if (!mcaManager) {
      throw new HandlerError('MCA_UNAVAILABLE', 'MCA system is not available')
    }

    const hasAccess = await userHasAppAccess(mcaService, workspaceService, ctx.userId, appId)
    if (!hasAccess) {
      throw new HandlerError('ACCESS_DENIED', `You don't have access to app ${appId}`)
    }

    const toolsResult = await mcaManager.getToolsForApp(appId)
    const app = await mcaService.getApp(appId)

    return {
      requestId,
      appId,
      appName: app?.name,
      status: toolsResult.status,
      error: toolsResult.error,
      tools: toolsResult.tools.map((t) => ({
        name: t.name.replace(`${app?.name}_`, ''),
        fullName: t.name,
        description: t.description,
        inputSchema: t.input_schema,
      })),
    }
  }
}
