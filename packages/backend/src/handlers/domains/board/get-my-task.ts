/**
 * board.get-my-task — Get the task linked to the current conversation (singular)
 *
 * Returns the single task associated with the calling agent's current channel.
 * This is the fast path for runners that only need their active task.
 * No parameters required — the channelId is resolved from the WS context.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import { enrichTaskWithColumn } from './_helpers'

interface GetMyTaskData {
  channelId: string
  agentId: string
}

export function createGetMyTaskHandler(boardService: BoardService) {
  return async function getMyTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetMyTaskData
    const { channelId, agentId } = data

    if (!channelId || !agentId) {
      throw new HandlerError('MISSING_FIELDS', 'channelId and agentId are required')
    }

    const task = await boardService.getTaskByChannel(channelId)

    if (!task) {
      return { channelId, task: null }
    }

    // Verify this task actually belongs to the calling agent
    if (task.assignedAgentId !== agentId) {
      throw new HandlerError('FORBIDDEN', 'This task is not assigned to you')
    }

    const board = await boardService.getBoard(task.boardId)
    const project = board ? await boardService.getProject(board.projectId) : null
    const enriched = enrichTaskWithColumn(task, board)

    return {
      channelId,
      task: {
        ...enriched,
        ...(project ? { projectId: project.projectId, projectName: project.name } : {}),
      },
    }
  }
}
