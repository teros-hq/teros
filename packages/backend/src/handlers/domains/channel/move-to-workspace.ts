/**
 * channel.move-to-workspace — Move a conversation from one workspace to another
 *
 * Validates that the caller has write access to both the source and target
 * workspaces, then updates the channel's workspaceId. Messages follow the
 * channel automatically (they are linked via channelId, not workspaceId).
 *
 * Edge cases:
 * - Agent not in target workspace → warning returned (conversation still moves)
 * - Board task linked to channel → warning returned (task stays in original board)
 * - Channel already in target workspace → no-op, returns info warning
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { ChannelManager } from '../../../services/channel-manager'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { SessionManager } from '../../../services/session-manager'

interface MoveToWorkspaceData {
  channelId: string
  targetWorkspaceId: string
}

export function createMoveToWorkspaceHandler(
  channelManager: ChannelManager,
  workspaceService: WorkspaceService | null,
  sessionManager: SessionManager,
) {
  return async function moveToWorkspace(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as MoveToWorkspaceData

    if (!data.channelId) {
      throw new HandlerError('MISSING_CHANNEL_ID', 'channelId is required')
    }
    if (!data.targetWorkspaceId) {
      throw new HandlerError('MISSING_TARGET_WORKSPACE', 'targetWorkspaceId is required')
    }

    if (!workspaceService) {
      throw new HandlerError('SERVICE_UNAVAILABLE', 'WorkspaceService not available')
    }

    // 1. Verify the channel exists
    const channel = await channelManager.getChannel(data.channelId)
    if (!channel) {
      throw new HandlerError('CHANNEL_NOT_FOUND', 'Channel not found')
    }

    // 2. Verify caller has access to the channel
    const canAccessChannel = await channelManager.canAccessChannel(data.channelId, ctx.userId)
    if (!canAccessChannel) {
      throw new HandlerError('UNAUTHORIZED', 'You do not have access to this channel')
    }

    const sourceWorkspaceId = channel.workspaceId

    // 3. Verify caller has write access to the SOURCE workspace
    //    (must be a member/admin/owner to move a conversation OUT)
    const canWriteSource = await workspaceService.canWrite(sourceWorkspaceId, ctx.userId)
    if (!canWriteSource) {
      throw new HandlerError(
        'SOURCE_WORKSPACE_ACCESS_DENIED',
        'You do not have write access to the source workspace',
      )
    }

    // 4. Verify caller has write access to the TARGET workspace
    //    (must be a member/admin/owner to move a conversation IN)
    const canWriteTarget = await workspaceService.canWrite(data.targetWorkspaceId, ctx.userId)
    if (!canWriteTarget) {
      throw new HandlerError(
        'TARGET_WORKSPACE_ACCESS_DENIED',
        'You do not have write access to the target workspace',
      )
    }

    // 5. Verify the target workspace exists and is active
    const targetWorkspace = await workspaceService.getWorkspace(data.targetWorkspaceId)
    if (!targetWorkspace || targetWorkspace.status !== 'active') {
      throw new HandlerError(
        'TARGET_WORKSPACE_NOT_AVAILABLE',
        'The target workspace does not exist or is not active',
      )
    }

    // 6. Perform the move
    const { channel: updatedChannel, warnings } = await channelManager.moveChannelToWorkspace(
      data.channelId,
      data.targetWorkspaceId,
    )

    if (!updatedChannel) {
      throw new HandlerError(
        'MOVE_FAILED',
        'Failed to move the channel — it may have been deleted during the operation',
      )
    }

    // 7. Broadcast channel_list_status to the caller's sessions so the UI
    //    refreshes the conversation list (the channel now belongs to a
    //    different workspace and may disappear from the current view).
    const sessions = sessionManager.getUserSessions(ctx.userId)
    const broadcastMsg = JSON.stringify({
      type: 'channel_list_status',
      channelId: data.channelId,
      action: 'moved',
      channel: {
        channelId: data.channelId,
        status: updatedChannel.status,
        workspaceId: data.targetWorkspaceId,
      },
    })
    for (const session of sessions) {
      if (session.ws.readyState === session.ws.OPEN) {
        session.ws.send(broadcastMsg)
      }
    }

    return {
      channelId: data.channelId,
      sourceWorkspaceId,
      targetWorkspaceId: data.targetWorkspaceId,
      warnings,
      channel: {
        channelId: updatedChannel.channelId,
        status: updatedChannel.status,
        workspaceId: updatedChannel.workspaceId,
        updatedAt: updatedChannel.updatedAt,
      },
    }
  }
}
