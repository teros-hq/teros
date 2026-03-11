/**
 * board.batch-create-tasks — Create multiple tasks atomically
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService, CreateTaskInput } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { SessionManager } from '../../../services/session-manager'

interface BatchCreateTasksData {
  projectId: string
  tasks: CreateTaskInput[]
}

export function createBatchCreateTasksHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  sessionManager: SessionManager,
) {
  function broadcastBoardEvent(boardId: string, event: Record<string, any>): void {
    const subscribers = sessionManager.getBoardSubscribers(boardId)
    if (subscribers.length === 0) return
    const payload = JSON.stringify(event)
    for (const session of subscribers) {
      if (session.ws && session.ws.readyState === 1) {
        session.ws.send(payload)
      }
    }
  }

  return async function batchCreateTasks(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as BatchCreateTasksData
    const { projectId, tasks: taskInputs } = data

    if (!projectId || !taskInputs || !Array.isArray(taskInputs)) {
      throw new HandlerError('MISSING_FIELDS', 'projectId and tasks array are required')
    }

    const project = await boardService.getProject(projectId)
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'No write access')
    }

    const tasks = await boardService.batchCreateTasks(project.boardId, ctx.userId, taskInputs)

    broadcastBoardEvent(project.boardId, { type: 'board_tasks_batch_created', tasks })

    return { projectId, tasks, count: tasks.length }
  }
}
