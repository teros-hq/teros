/**
 * board.get-tasks-by-agent — Get all tasks assigned to a specific agent in a workspace
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import { enrichTasksAcrossBoards } from './_helpers'

interface GetTasksByAgentData {
  workspaceId: string
  agentId: string
  tags?: string[]
}

export function createGetTasksByAgentHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
) {
  return async function getTasksByAgent(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetTasksByAgentData
    const { workspaceId, agentId, tags } = data

    if (!workspaceId || !agentId) {
      throw new HandlerError('MISSING_FIELDS', 'workspaceId and agentId are required')
    }

    const role = await workspaceService.getUserRole(workspaceId, ctx.userId)
    if (role === null) {
      throw new HandlerError('FORBIDDEN', 'No access')
    }

    const tasks = await boardService.getTasksByAgent(workspaceId, agentId, tags)
    const enriched = await enrichTasksAcrossBoards(tasks, boardService)

    return { agentId, tasks: enriched }
  }
}
