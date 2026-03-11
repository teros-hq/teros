/**
 * board.list-projects — List projects in a workspace
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface ListProjectsData {
  workspaceId: string
}

export function createListProjectsHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
) {
  return async function listProjects(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListProjectsData
    const { workspaceId } = data

    if (!workspaceId) {
      throw new HandlerError('MISSING_FIELDS', 'workspaceId is required')
    }

    const role = await workspaceService.getUserRole(workspaceId, ctx.userId)
    if (role === null) {
      throw new HandlerError('FORBIDDEN', 'No access to this workspace')
    }

    const projects = await boardService.listProjects(workspaceId)

    return { workspaceId, projects }
  }
}
