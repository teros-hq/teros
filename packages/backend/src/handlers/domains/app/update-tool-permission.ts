/**
 * app.update-tool-permission — Update a single tool's permission for an app
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ToolPermission } from '../../../types/database'
import type { McaService } from '../../../services/mca-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import {
  getPermissionsSummary,
  isPrivateTool,
  normalizeToolName,
} from '../../../types/permissions'

interface UpdateToolPermissionData {
  appId: string
  toolName: string
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

export function createUpdateToolPermissionHandler(
  mcaService: McaService,
  workspaceService?: WorkspaceService,
) {
  return async function updateToolPermission(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateToolPermissionData
    const { appId, toolName, permission } = data

    if (!appId || !toolName || !permission) {
      throw new HandlerError('MISSING_PARAMS', 'appId, toolName, and permission are required')
    }
    if (!['allow', 'ask', 'forbid'].includes(permission)) {
      throw new HandlerError('INVALID_PERMISSION', 'Permission must be: allow, ask, or forbid')
    }

    const shortToolName = toolName.includes('_')
      ? toolName.split('_').slice(1).join('_')
      : toolName

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

    const mca = await mcaService.getMcaFromCatalog(app.mcaId)
    if (!mca) {
      throw new HandlerError('MCA_NOT_FOUND', `MCA '${app.mcaId}' not found`)
    }

    const normalizedShortName = normalizeToolName(shortToolName)
    const normalizedTools = mca.tools.map(normalizeToolName)
    if (!normalizedTools.includes(normalizedShortName)) {
      throw new HandlerError('TOOL_NOT_FOUND', `Tool '${shortToolName}' not found in this app`)
    }

    const updated = await mcaService.updateToolPermission(appId, toolName, permission)
    if (!updated) {
      throw new HandlerError('UPDATE_FAILED', 'Failed to update permission')
    }

    const publicTools = mca.tools.filter((name) => !isPrivateTool(name))
    const summary = getPermissionsSummary(updated.permissions, publicTools)

    console.log(`[app.update-tool-permission] Updated ${toolName} = ${permission}`)

    return { success: true, appId, toolName, permission, summary }
  }
}
