/**
 * board.update-project — Update project metadata
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface UpdateProjectData {
  projectId: string
  name?: string
  description?: string
  context?: string
}

export function createUpdateProjectHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
) {
  return async function updateProject(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateProjectData
    const { projectId, name, description, context } = data

    if (!projectId) {
      throw new HandlerError('MISSING_FIELDS', 'projectId is required')
    }

    const existing = await boardService.getProject(projectId)
    if (!existing) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    const role = await workspaceService.getUserRole(existing.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'No write access')
    }

    const project = await boardService.updateProject(projectId, { name, description, context })
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    return { project }
  }
}
