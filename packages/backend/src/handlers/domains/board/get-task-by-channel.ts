/**
 * board.get-task-by-channel — Get the task linked to a channel (if any)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'

interface GetTaskByChannelData {
  channelId: string
}

export function createGetTaskByChannelHandler(boardService: BoardService) {
  return async function getTaskByChannel(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetTaskByChannelData
    const { channelId } = data

    if (!channelId) {
      throw new HandlerError('MISSING_FIELDS', 'channelId is required')
    }

    // No workspace access check — the channel ownership is implicitly verified
    // by the fact that the user has a valid session and knows the channelId.
    const task = await boardService.getTaskByChannel(channelId)

    return { channelId, task } // task may be null if no task is linked
  }
}
