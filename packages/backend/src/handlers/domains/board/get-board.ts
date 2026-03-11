/**
 * board.get — Get board with tasks and agents for a project
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface GetBoardData {
  projectId: string
}

export function createGetBoardHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
) {
  return async function getBoard(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetBoardData
    const { projectId } = data

    if (!projectId) {
      throw new HandlerError('MISSING_FIELDS', 'projectId is required')
    }

    const project = await boardService.getProject(projectId)
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role === null) {
      throw new HandlerError('FORBIDDEN', 'No access')
    }

    const board = await boardService.getBoardByProject(projectId)
    if (!board) {
      throw new HandlerError('NOT_FOUND', 'Board not found')
    }

    // Get tasks grouped by column
    const tasks = await boardService.listTasks(board.boardId)

    // Resolve agent names/avatars
    const agentIds = boardService.collectAgentIds(tasks)
    const agents = await boardService.resolveAgents(agentIds)

    return { board, tasks, agents }
  }
}
