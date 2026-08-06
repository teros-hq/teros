/**
 * app.get-tools — Get tools list with permissions for an app (from App.permissions)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaManager } from '../../../services/mca-manager'
import type { McaService } from '../../../services/mca-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import { buildAppPermissionsView } from './_permissions-view'

interface GetToolsData {
  appId: string
}

export function createGetToolsHandler(
  mcaService: McaService,
  mcaManager: McaManager | null,
  workspaceService?: WorkspaceService,
) {
  return async function getTools(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetToolsData
    const { appId } = data

    if (!appId) {
      throw new HandlerError('MISSING_APP_ID', 'appId is required')
    }

    const app = await mcaService.getApp(appId)
    if (!app) {
      throw new HandlerError('APP_NOT_FOUND', 'App not found')
    }

    // Check access: owner, system app, or workspace member
    const canAccess =
      app.ownerId === ctx.userId ||
      app.ownerId === 'system' ||
      (workspaceService && (await workspaceService.canAccess(app.ownerId, ctx.userId)))
    if (!canAccess) {
      throw new HandlerError('ACCESS_DENIED', 'Access denied')
    }

    const mca = await mcaService.getMcaFromCatalog(app.mcaId)
    if (!mca) {
      throw new HandlerError('MCA_NOT_FOUND', 'MCA not found')
    }

    const { tools, summary } = await buildAppPermissionsView(mcaManager, app, appId, mca.tools)

    console.log(`[app.get-tools] Sent tools for ${appId}: ${tools.length} tools`)

    return {
      appId,
      appName: app.name,
      mcaName: mca.name,
      defaultPermission: app.permissions?.defaultPermission || 'ask',
      tools,
      summary,
    }
  }
}
