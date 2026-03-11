/**
 * workspace.get — Get details of a specific workspace
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'

interface GetWorkspaceData {
  workspaceId: string
}

export function createGetWorkspaceHandler(workspaceService: WorkspaceService) {
  return async function getWorkspace(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetWorkspaceData

    if (!data.workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }

    if (!(await workspaceService.canAccess(data.workspaceId, ctx.userId))) {
      throw new HandlerError('ACCESS_DENIED', 'You do not have access to this workspace')
    }

    const workspace = await workspaceService.getWorkspace(data.workspaceId)
    if (!workspace) {
      throw new HandlerError('WORKSPACE_NOT_FOUND', 'Workspace not found')
    }

    const role = await workspaceService.getUserRole(data.workspaceId, ctx.userId)

    return {
      workspace: {
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        description: workspace.description,
        context: workspace.context,
        volumeId: workspace.volumeId,
        ownerId: workspace.ownerId,
        members: workspace.members,
        settings: workspace.settings,
        appearance: workspace.appearance,
        role,
        status: workspace.status,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      },
    }
  }
}
