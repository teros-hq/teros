/**
 * board.update-task-status — Update task status (manager action)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { SessionManager } from '../../../services/session-manager'

interface UpdateTaskStatusData {
  taskId: string
  status: string
  actor?: string
}

export function createUpdateTaskStatusHandler(
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

  return async function updateTaskStatus(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateTaskStatusData
    const { taskId, status, actor } = data

    if (!taskId || !status) {
      throw new HandlerError('MISSING_FIELDS', 'taskId and status are required')
    }

    const existing = await boardService.getTask(taskId)
    if (!existing) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    const board = await boardService.getBoard(existing.boardId)
    const project = board ? await boardService.getProject(board.projectId) : null
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'No write access')
    }

    const result = await boardService.updateTaskStatus(taskId, status as any, actor || ctx.userId)
    if (!result) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    broadcastBoardEvent(result.task.boardId, { type: 'board_task_updated', task: result.task })

    return { task: result.task, previousStatus: result.previousStatus }
  }
}
