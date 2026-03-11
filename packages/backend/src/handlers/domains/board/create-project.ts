/**
 * board.create-project — Create a new project with its board
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface CreateProjectData {
  workspaceId: string
  name: string
  description?: string
}

export function createCreateProjectHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
) {
  return async function createProject(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CreateProjectData
    const { workspaceId, name, description } = data

    if (!workspaceId || !name) {
      throw new HandlerError('MISSING_FIELDS', 'workspaceId and name are required')
    }

    const role = await workspaceService.getUserRole(workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'No write access to this workspace')
    }

    const { project, board } = await boardService.createProject(workspaceId, ctx.userId, {
      name,
      description,
    })

    return { project, board }
  }
}
