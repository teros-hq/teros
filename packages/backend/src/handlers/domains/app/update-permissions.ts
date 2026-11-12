/**
 * app.update-permissions — Update all permissions for an app (deprecated, kept for compat)
 *
 * @deprecated Use app.update-tool-permission or app.set-all-tool-permissions instead
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { AppToolPermissions, ToolPermission } from '../../../types/database'
import type { McaManager } from '../../../services/mca-manager'
import type { McaService } from '../../../services/mca-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import { buildAppPermissionsView } from './_permissions-view'

interface UpdatePermissionsData {
  appId: string
  permissions: {
    defaultPermission: ToolPermission
    tools?: Record<string, ToolPermission>
  }
}

export function createUpdatePermissionsHandler(
  mcaService: McaService,
  mcaManager: McaManager | null,
  workspaceService?: WorkspaceService,
) {
  return async function updatePermissions(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdatePermissionsData
    const { appId, permissions: rawPermissions } = data

    if (!appId || !rawPermissions) {
      throw new HandlerError('MISSING_PARAMS', 'appId and permissions are required')
    }
    if (
      !rawPermissions.defaultPermission ||
      !['allow', 'ask', 'forbid'].includes(rawPermissions.defaultPermission)
    ) {
      throw new HandlerError('INVALID_PERMISSIONS', 'Invalid defaultPermission')
    }

    const permissions: AppToolPermissions = {
      defaultPermission: rawPermissions.defaultPermission,
      tools: rawPermissions.tools || {},
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

    const updated = await mcaService.updateAppPermissions(appId, permissions)
    if (!updated) {
      throw new HandlerError('UPDATE_FAILED', 'Failed to update permissions')
    }

    const mca = await mcaService.getMcaFromCatalog(app.mcaId)
    const { summary } = await buildAppPermissionsView(mcaManager, updated, appId, mca?.tools || [])

    console.log(`[app.update-permissions] Updated permissions for ${appId}`)

    return { success: true, appId, permissions: updated.permissions, summary }
  }
}
