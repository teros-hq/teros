/**
 * board.update-config — Update board configuration (columns, etc.)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface UpdateBoardConfigData {
  projectId: string
  config: any
}

export function createUpdateBoardConfigHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
) {
  return async function updateBoardConfig(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateBoardConfigData
    const { projectId, config } = data

    if (!projectId || !config) {
      throw new HandlerError('MISSING_FIELDS', 'projectId and config are required')
    }

    const project = await boardService.getProject(projectId)
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'No write access')
    }

    const board = await boardService.updateBoardConfig(project.boardId, config)
    if (!board) {
      throw new HandlerError('NOT_FOUND', 'Board not found')
    }

    return { projectId, config: board.config }
  }
}
