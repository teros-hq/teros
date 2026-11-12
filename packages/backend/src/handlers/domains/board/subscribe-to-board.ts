/**
 * board.subscribe-to-board — Subscribe the current conversation to board events
 *
 * Upserts a BoardSubscription linking this channel to the given board.
 * Subsequent board events that pass the filter will be delivered to this channel.
 *
 * Migration note (Fase 4): becomes a thin wrapper over the generic
 * SubscriptionService.subscribe(mcaId, channelId, agentId, filter).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import type { ChannelManager } from '../../../services/channel-manager'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { BoardSubscriptionFilter } from '../../../types/database'

interface SubscribeToBoardData {
  boardId: string
  channelId: string   // passed by MCA from context.execution.channelId
  agentId?: string    // passed by MCA from context.execution.agentId
  filter?: BoardSubscriptionFilter
}

export function createSubscribeToBoardHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  boardSubscriptionService: BoardSubscriptionService,
  channelManager: ChannelManager,
) {
  return async function subscribeToBoard(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SubscribeToBoardData
    const { boardId, channelId, agentId, filter } = data

    if (!boardId) throw new HandlerError('MISSING_FIELDS', 'boardId is required')
    if (!channelId) throw new HandlerError('MISSING_FIELDS', 'channelId is required (pass from execution context)')

    // Verify board exists and caller has access
    const board = await boardService.getBoard(boardId)
    if (!board) throw new HandlerError('NOT_FOUND', 'Board not found')

    const project = await boardService.getProject(board.projectId)
    if (!project) throw new HandlerError('NOT_FOUND', 'Project not found')

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role === null) throw new HandlerError('FORBIDDEN', 'No access to this board')

    // Board events are delivered into channelId and can wake its agent, so the
    // caller must also have access to that conversation. agentId is client
    // supplied: never pass it here (canAccessChannel trusts a matching agentId).
    if (!(await channelManager.canAccessChannel(channelId, ctx.userId))) {
      throw new HandlerError('FORBIDDEN', 'No access to this channel')
    }

    const { subscription: sub, created } = await boardSubscriptionService.subscribeWithStatus(
      boardId,
      channelId,
      agentId ?? ctx.userId,
      filter ?? {},
    )

    return {
      subscriptionId: sub.subscriptionId,
      boardId: sub.boardId,
      filter: sub.filter,
      // fb_d211b16343bd3034: subscribing twice on the same board+channel is an
      // UPSERT — the previous filter is replaced in place. Surfaced so the
      // caller knows whether they created a new subscription or replaced one.
      created,
      message: created
        ? `Subscribed to board ${boardId}. You will receive board events in this conversation.`
        : `Updated existing subscription to board ${boardId} — the previous filter was REPLACED by this one (same subscription, same conversation).`,
    }
  }
}
