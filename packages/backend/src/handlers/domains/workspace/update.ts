/**
 * workspace.update — Update an existing workspace
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'

interface UpdateWorkspaceData {
  workspaceId: string
  name?: string
  description?: string
  context?: string
  appearance?: { color?: string; icon?: string }
}

export function createUpdateWorkspaceHandler(
  workspaceService: WorkspaceService,
  pubSubService?: PubSubService | null,
) {
  return async function updateWorkspace(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateWorkspaceData

    if (!data.workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }

    let workspace: any
    try {
      workspace = await workspaceService.updateWorkspace(data.workspaceId, ctx.userId, {
        name: data.name,
        description: data.description,
        context: data.context,
        appearance: data.appearance,
      })
    } catch (error: any) {
      if (error.message?.includes('Permission denied')) {
        throw new HandlerError('PERMISSION_DENIED', error.message)
      }
      if (error.message?.includes('Invalid workspace')) {
        throw new HandlerError('INVALID_INPUT', error.message)
      }
      throw error
    }

    if (!workspace) {
      throw new HandlerError('WORKSPACE_NOT_FOUND', 'Workspace not found')
    }

    console.log(`[workspace.update] Updated workspace ${data.workspaceId}`)

    const workspacePayload = {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      description: workspace.description,
      context: workspace.context,
      appearance: workspace.appearance,
    }

    if (pubSubService) {
      await pubSubService.broadcastToWorkspace(workspace.workspaceId, {
        type: 'workspace.updated',
        workspace: workspacePayload,
      })
    }

    return { workspace: workspacePayload }
  }
}
