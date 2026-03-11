/**
 * board.get-tasks-by-agent — Get all tasks assigned to a specific agent in a workspace
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface GetTasksByAgentData {
  workspaceId: string
  agentId: string
}

export function createGetTasksByAgentHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
) {
  return async function getTasksByAgent(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetTasksByAgentData
    const { workspaceId, agentId } = data

    if (!workspaceId || !agentId) {
      throw new HandlerError('MISSING_FIELDS', 'workspaceId and agentId are required')
    }

    const role = await workspaceService.getUserRole(workspaceId, ctx.userId)
    if (role === null) {
      throw new HandlerError('FORBIDDEN', 'No access')
    }

    const tasks = await boardService.getTasksByAgent(workspaceId, agentId)

    return { agentId, tasks }
  }
}
