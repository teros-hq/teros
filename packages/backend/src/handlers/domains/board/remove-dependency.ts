/**
 * board.remove-dependency — Remove a dependency between two tasks
 *
 * Removes the edge: taskId no longer depends on dependsOnTaskId.
 * Idempotent — if the dependency does not exist, returns the task unchanged.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import { BoardSubscriptionService as BSS } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'

interface RemoveDependencyData {
  /** The task that currently has the dependency */
  taskId: string
  /** The task to remove from taskId's dependencies */
  dependsOnTaskId: string
}

export function createRemoveDependencyHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  boardSubscriptionService?: BoardSubscriptionService,
) {
  return async function removeDependency(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as RemoveDependencyData
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

    const task = await boardService.removeDependency(taskId, dependsOnTaskId, ctx.userId)

    pubSubService.broadcastToTopic(`board:${task.boardId}`, { type: 'board_task_updated', task })

    // Emit board.dependency_removed to subscribers
    if (boardSubscriptionService) {
      const payload = {
        taskId: task.taskId,
        taskTitle: task.title,
        assignedAgentId: task.assignedAgentId,
        tags: task.tags,
        columnId: task.columnId,
        dependsOnTaskId,
      }
      boardSubscriptionService.notifySubscribers(task.boardId, {
        eventType: 'board.dependency_removed',
        boardId: task.boardId,
        formattedMessage: BSS.formatEventMessage({ eventType: 'board.dependency_removed', boardId: task.boardId, payload }),
        payload,
      })
    }

    return { task }
  }
}
