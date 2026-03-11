/**
 * board.move-my-task — Move a task assigned to the calling agent
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { SessionManager } from '../../../services/session-manager'

interface MoveMyTaskData {
  taskId: string
  columnId: string
  position?: number
  agentId: string
}

export function createMoveMyTaskHandler(
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

  return async function moveMyTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as MoveMyTaskData
    const { taskId, columnId, position, agentId } = data

    if (!taskId || !columnId || !agentId) {
      throw new HandlerError('MISSING_FIELDS', 'taskId, columnId, and agentId are required')
    }

    // Verify task exists and is assigned to this agent
    const task = await boardService.getTask(taskId)
    if (!task) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    if (task.assignedAgentId !== agentId) {
      throw new HandlerError('FORBIDDEN', 'You can only move tasks assigned to you')
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

    const updatedTask = await boardService.moveTask(taskId, agentId, columnId, position)
    if (!updatedTask) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    broadcastBoardEvent(updatedTask.boardId, { type: 'board_task_updated', task: updatedTask })

    return { task: updatedTask }
  }
}
