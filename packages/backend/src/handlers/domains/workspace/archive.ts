/**
 * workspace.archive — Archive a workspace
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'

interface ArchiveWorkspaceData {
  workspaceId: string
}

export function createArchiveWorkspaceHandler(workspaceService: WorkspaceService) {
  return async function archiveWorkspace(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ArchiveWorkspaceData

    if (!data.workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }

    let success: boolean
    try {
      success = await workspaceService.archiveWorkspace(data.workspaceId, ctx.userId)
    } catch (error: any) {
      if (error.message?.includes('Permission denied')) {
        throw new HandlerError('PERMISSION_DENIED', error.message)
      }
      throw error
    }

    if (!success) {
      throw new HandlerError('WORKSPACE_NOT_FOUND', 'Workspace not found')
    }

    console.log(`[workspace.archive] Archived workspace ${data.workspaceId}`)

    return { workspaceId: data.workspaceId }
  }
}
