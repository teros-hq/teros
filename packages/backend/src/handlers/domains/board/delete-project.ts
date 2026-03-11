/**
 * board.delete-project — Delete a project (admin/owner only)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface DeleteProjectData {
  projectId: string
}

export function createDeleteProjectHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
) {
  return async function deleteProject(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as DeleteProjectData
    const { projectId } = data

    if (!projectId) {
      throw new HandlerError('MISSING_FIELDS', 'projectId is required')
    }

    const project = await boardService.getProject(projectId)
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    // Only admin/owner can delete
    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin') {
      throw new HandlerError('FORBIDDEN', 'Only workspace admin or owner can delete projects')
    }

    await boardService.deleteProject(projectId)

    return { projectId }
  }
}
