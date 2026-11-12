/**
 * app.set-all-tool-permissions — Set all tools in an app to the same permission
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ToolPermission } from '../../../types/database'
import type { McaManager } from '../../../services/mca-manager'
import type { McaService } from '../../../services/mca-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import { buildAppPermissionsView } from './_permissions-view'

interface SetAllToolPermissionsData {
  appId: string
  permission: ToolPermission
}

export function createSetAllToolPermissionsHandler(
  mcaService: McaService,
  mcaManager: McaManager | null,
  workspaceService?: WorkspaceService,
) {
  return async function setAllToolPermissions(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SetAllToolPermissionsData
    const { appId, permission } = data

    if (!appId || !permission) {
      throw new HandlerError('MISSING_PARAMS', 'appId and permission are required')
    }
    if (!['allow', 'ask', 'forbid'].includes(permission)) {
      throw new HandlerError('INVALID_PERMISSION', 'Permission must be: allow, ask, or forbid')
    }

    const app = await mcaService.getApp(appId)
    if (!app) {
      throw new HandlerError('APP_NOT_FOUND', 'App not found')
    }

    if (!(await mcaService.canManageApp(app, ctx.userId))) {
      throw new HandlerError(
        'ACCESS_DENIED',
        'Access denied - you need admin access to modify permissions',
      )
    }

    const updated = await mcaService.setAllToolPermissions(appId, permission)
    if (!updated) {
      throw new HandlerError('UPDATE_FAILED', 'Failed to update permissions')
    }

    const mca = await mcaService.getMcaFromCatalog(app.mcaId)
    const { summary } = await buildAppPermissionsView(mcaManager, updated, appId, mca?.tools || [])

    console.log(`[app.set-all-tool-permissions] Set all tools to ${permission} for ${appId}`)

    return { success: true, appId, permission, summary }
  }
}
