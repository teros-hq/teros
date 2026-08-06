/**
 * workspace.archive — Archive a workspace
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'

interface ArchiveWorkspaceData {
  workspaceId: string
}

export function createArchiveWorkspaceHandler(
  workspaceService: WorkspaceService,
  pubSubService?: PubSubService | null,
) {
  return async function archiveWorkspace(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ArchiveWorkspaceData

    if (!data.workspaceId) {
      throw new HandlerError('MISSING_WORKSPACE_ID', 'workspaceId is required')
    }

    // Capture members BEFORE archiving so we can fan-out the event even if a
    // future change to broadcastToWorkspace decides to skip non-active workspaces.
    const beforeArchive = await workspaceService.getWorkspace(data.workspaceId)
    const memberUserIds = beforeArchive
      ? new Set<string>([
          beforeArchive.ownerId,
          ...beforeArchive.members.map((m) => m.userId),
        ])
      : new Set<string>()

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

    if (pubSubService && memberUserIds.size > 0) {
      const event = { type: 'workspace.archived', workspaceId: data.workspaceId }
      for (const userId of memberUserIds) {
        pubSubService.broadcastToUser(userId as any, event)
      }
    }

    return { workspaceId: data.workspaceId }
  }
}
