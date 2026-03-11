/**
 * board.get-summary — Get board summary (task counts per column)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface GetBoardSummaryData {
  projectId: string
}

export function createGetBoardSummaryHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
) {
  return async function getBoardSummary(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetBoardSummaryData
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

    const summary = await boardService.getBoardSummary(project.boardId)
    if (!summary) {
      throw new HandlerError('NOT_FOUND', 'Board not found')
    }

    return { projectId, ...summary }
  }
}
