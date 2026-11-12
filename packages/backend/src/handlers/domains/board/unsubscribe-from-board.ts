/**
 * board.unsubscribe-from-board — Cancel the current conversation's subscription to a board
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import type { ChannelManager } from '../../../services/channel-manager'

interface UnsubscribeFromBoardData {
  boardId: string
  channelId: string   // passed by MCA from context.execution.channelId
}

export function createUnsubscribeFromBoardHandler(
  boardSubscriptionService: BoardSubscriptionService,
  channelManager: ChannelManager,
) {
  return async function unsubscribeFromBoard(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UnsubscribeFromBoardData
    const { boardId, channelId } = data

    if (!boardId) throw new HandlerError('MISSING_FIELDS', 'boardId is required')
    if (!channelId) throw new HandlerError('MISSING_FIELDS', 'channelId is required')

    // Subscriptions are keyed by (boardId, channelId): only someone with access
    // to the conversation may remove its subscription.
    if (!(await channelManager.canAccessChannel(channelId, ctx.userId))) {
      throw new HandlerError('FORBIDDEN', 'No access to this channel')
    }

    const deleted = await boardSubscriptionService.unsubscribe(boardId, channelId)
    if (!deleted) {
      throw new HandlerError('NOT_FOUND', `No active subscription found for board ${boardId} in this conversation`)
    }

    return { message: `Unsubscribed from board ${boardId}.` }
  }
}
