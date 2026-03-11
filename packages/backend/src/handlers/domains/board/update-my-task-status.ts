/**
 * board.update-my-task-status — Update status of a task assigned to the calling agent
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { SessionManager } from '../../../services/session-manager'

interface UpdateMyTaskStatusData {
  taskId: string
  status: string
  agentId: string
}

export function createUpdateMyTaskStatusHandler(
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

  return async function updateMyTaskStatus(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateMyTaskStatusData
    const { taskId, status, agentId } = data

    if (!taskId || !status || !agentId) {
      throw new HandlerError('MISSING_FIELDS', 'taskId, status, and agentId are required')
    }

    // Verify task exists and is assigned to this agent
    const task = await boardService.getTask(taskId)
    if (!task) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    if (task.assignedAgentId !== agentId) {
      throw new HandlerError('FORBIDDEN', 'You can only update status of tasks assigned to you')
    }

    // Verify workspace access
    const board = await boardService.getBoard(task.boardId)
    const project = board ? await boardService.getProject(board.projectId) : null
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role === null) {
      throw new HandlerError('FORBIDDEN', 'No access')
    }

    const result = await boardService.updateTaskStatus(taskId, status as any, agentId)
    if (!result) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    broadcastBoardEvent(result.task.boardId, { type: 'board_task_updated', task: result.task })

    return { task: result.task, previousStatus: result.previousStatus }
  }
}
