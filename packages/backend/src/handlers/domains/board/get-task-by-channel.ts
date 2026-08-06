/**
 * board.get-task-by-channel — Get the task linked to a channel (if any)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { ChannelManager } from '../../../services/channel-manager'

interface GetTaskByChannelData {
  channelId: string
}

export function createGetTaskByChannelHandler(
  boardService: BoardService,
  channelManager: ChannelManager,
) {
  return async function getTaskByChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetTaskByChannelData
    const { channelId } = data

    if (!channelId) {
      throw new HandlerError('MISSING_FIELDS', 'channelId is required')
    }

    // SEC-2 (TER-721 / M5): "the user knows the channelId" is not authorization.
    // Any authenticated user could otherwise read any task (title/description/
    // instructions/assignee) by channelId. Gate on channel access.
    if (!(await channelManager.canAccessChannel(channelId, ctx.userId))) {
      throw new HandlerError('ACCESS_DENIED', 'You do not have access to this channel')
    }

    const task = await boardService.getTaskByChannel(channelId)

    return { channelId, task } // task may be null if no task is linked
  }
}
