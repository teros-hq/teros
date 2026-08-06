/**
 * board.list-board-subscriptions — List active board subscriptions for the current conversation
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'

interface ListBoardSubscriptionsData {
  channelId: string   // passed by MCA from context.execution.channelId
}

export function createListBoardSubscriptionsHandler(
  boardService: BoardService,
  boardSubscriptionService: BoardSubscriptionService,
) {
  return async function listBoardSubscriptions(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListBoardSubscriptionsData
    const { channelId } = data

    if (!channelId) throw new HandlerError('MISSING_FIELDS', 'channelId is required')

    const subs = await boardSubscriptionService.listByChannel(channelId)

    // Enrich with board/project names
    const enriched = await Promise.all(
      subs.map(async (sub) => {
        const board = await boardService.getBoard(sub.boardId)
        const project = board ? await boardService.getProject(board.projectId) : null
        return {
          subscriptionId: sub.subscriptionId,
          boardId: sub.boardId,
          boardName: project?.name ?? sub.boardId,
          filter: sub.filter,
          createdAt: sub.createdAt,
        }
      }),
    )

    return { subscriptions: enriched }
  }
}
