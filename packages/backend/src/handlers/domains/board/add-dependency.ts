/**
 * board.add-dependency — Add a dependency between two tasks
 *
 * Adds the edge: taskId depends on dependsOnTaskId.
 * Runs DFS cycle detection before persisting. If a cycle is detected,
 * all involved tasks are marked with status `circular_dependency` and
 * a descriptive error is returned to the client.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { SessionManager } from '../../../services/session-manager'

interface AddDependencyData {
  /** The task that gains the new dependency */
  taskId: string
  /** The task that taskId will depend on (must be completed first) */
  dependsOnTaskId: string
}

export function createAddDependencyHandler(
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

  return async function addDependency(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as AddDependencyData
    const { taskId, dependsOnTaskId } = data

    if (!taskId || !dependsOnTaskId) {
      throw new HandlerError('MISSING_FIELDS', 'taskId and dependsOnTaskId are required')
    }

    // Resolve workspace for permission check
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

    // Delegate to service — throws CIRCULAR_DEPENDENCY error if cycle detected
    let task
    try {
      task = await boardService.addDependency(taskId, dependsOnTaskId, ctx.userId)
    } catch (err: any) {
      if (err.message?.startsWith('CIRCULAR_DEPENDENCY:')) {
        // Broadcast updated tasks (now marked circular_dependency) to board subscribers
        broadcastBoardEvent(existing.boardId, {
          type: 'board_circular_dependency_detected',
          boardId: existing.boardId,
          taskId,
          dependsOnTaskId,
          message: err.message,
        })
        throw new HandlerError('CIRCULAR_DEPENDENCY', err.message)
      }
      throw err
    }

    broadcastBoardEvent(task.boardId, { type: 'board_task_updated', task })

    return { task }
  }
}
