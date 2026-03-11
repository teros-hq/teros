/**
 * board.get-project — Get a single project by ID
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface GetProjectData {
  projectId: string
}

export function createGetProjectHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
) {
  return async function getProject(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetProjectData
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
      throw new HandlerError('FORBIDDEN', 'No access to this workspace')
    }

    return { project }
  }
}
