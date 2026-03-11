/**
 * board.list-tasks — List tasks in a project with optional filters
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface ListTasksData {
  projectId: string
  columnId?: string
  assignedAgentId?: string
  priority?: string
  tags?: string[]
}

export function createListTasksHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
) {
  return async function listTasks(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ListTasksData
    const { projectId, ...filters } = data

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

    const tasks = await boardService.listTasks(project.boardId, filters as any)

    // Resolve agent names/avatars
    const agentIds = boardService.collectAgentIds(tasks)
    const agents = await boardService.resolveAgents(agentIds)

    return { projectId, tasks, agents }
  }
}
