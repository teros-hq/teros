/**
 * board.link-conversation — Link an existing channel to a task
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { ChannelManager } from '../../../services/channel-manager'

interface LinkConversationData {
  taskId: string
  channelId: string
}

export function createLinkConversationHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  channelManager: ChannelManager,
) {
  return async function linkConversation(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as LinkConversationData
    const { taskId, channelId } = data

    if (!taskId || !channelId) {
      throw new HandlerError('MISSING_FIELDS', 'taskId and channelId are required')
    }

    const existing = await boardService.getTask(taskId)
    if (!existing) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    const board = await boardService.getBoard(existing.boardId)
    const project = board ? await boardService.getProject(board.projectId) : null
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'No write access')
    }

    // The channel is client-supplied too, and linking shares it (below). It
    // must be a conversation the caller can see, from the task's workspace
    // (or their own workspace-less one), and only its creator may turn a
    // personal one into shared — the rule channel.set-scope applies
    // (canToggleScope). Otherwise any member could link a colleague's private
    // conversation to a task and expose it to the whole workspace.
    const channel = await channelManager.getChannel(channelId)
    if (
      !channel ||
      (channel.workspaceId && channel.workspaceId !== project.workspaceId) ||
      !(await channelManager.canAccessChannel(channelId, ctx.userId))
    ) {
      throw new HandlerError('FORBIDDEN', 'No access to this conversation')
    }
    if (channel.scope !== 'shared' && channel.userId !== ctx.userId) {
      throw new HandlerError('FORBIDDEN', "Only the conversation's creator can share it")
    }

    const task = await boardService.linkConversation(taskId, ctx.userId, channelId)
    if (!task) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    // REQ-3: Board-linked channels are auto-shared. Set scope to 'shared'
    // so all workspace members can see the conversation.
    // Unlinking does NOT revert scope (spec edge case).
    await channelManager.setChannelScope(channelId, 'shared')

    pubSubService.broadcastToTopic(`board:${task.boardId}`, { type: 'board_task_updated', task })

    return { task }
  }
}
