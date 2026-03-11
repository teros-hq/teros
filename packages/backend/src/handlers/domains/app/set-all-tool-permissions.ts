/**
 * app.set-all-tool-permissions — Set all tools in an app to the same permission
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ToolPermission } from '../../../types/database'
import type { McaService } from '../../../services/mca-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import { getPermissionsSummary, isPrivateTool } from '../../../types/permissions'

interface SetAllToolPermissionsData {
  appId: string
  permission: ToolPermission
}

async function canManageApp(
  app: { ownerId: string; ownerType?: string },
  userId: string,
  workspaceService?: WorkspaceService,
): Promise<boolean> {
  if (app.ownerId === userId) return true
  if (app.ownerId === 'system') return false
  if (app.ownerType === 'workspace' || app.ownerId.startsWith('work_')) {
    if (workspaceService) return workspaceService.canAdmin(app.ownerId, userId)
    return false
  }
  return false
}

export function createSetAllToolPermissionsHandler(
  mcaService: McaService,
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

    if (!(await canManageApp(app, ctx.userId, workspaceService))) {
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
    const publicTools = (mca?.tools || []).filter((name) => !isPrivateTool(name))
    const summary = getPermissionsSummary(updated.permissions, publicTools)

    console.log(`[app.set-all-tool-permissions] Set all tools to ${permission} for ${appId}`)

    return { success: true, appId, permission, summary }
  }
}
