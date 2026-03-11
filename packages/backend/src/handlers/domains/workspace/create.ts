/**
 * workspace.create — Create a new workspace for the current user
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'

interface CreateWorkspaceData {
  name: string
  description?: string
}

export function createCreateWorkspaceHandler(workspaceService: WorkspaceService) {
  return async function createWorkspace(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CreateWorkspaceData

    if (!data.name) {
      throw new HandlerError('MISSING_NAME', 'name is required')
    }

    const workspace = await workspaceService.createWorkspace(ctx.userId, {
      name: data.name,
      description: data.description,
    })

    console.log(`[workspace.create] Created workspace ${workspace.workspaceId} for user ${ctx.userId}`)

    return {
      workspace: {
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        description: workspace.description,
        volumeId: workspace.volumeId,
        role: 'owner',
        status: workspace.status,
        createdAt: workspace.createdAt,
      },
    }
  }
}
