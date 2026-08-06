/**
 * board.update-task — Update task properties
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import { BoardSubscriptionService as BSS } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'

interface UpdateTaskData {
  taskId: string
  title?: string
  description?: string
  instructions?: string
  priority?: string
  tags?: string[]
  assignedAgentId?: string | null
}

export function createUpdateTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  boardSubscriptionService?: BoardSubscriptionService,
) {
  return async function updateTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UpdateTaskData
    const { taskId, ...updateInput } = data

    if (!taskId) {
      throw new HandlerError('MISSING_FIELDS', 'taskId is required')
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

    const task = await boardService.updateTask(taskId, ctx.userId, updateInput as any)
    if (!task) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    pubSubService.broadcastToTopic(`board:${task.boardId}`, { type: 'board_task_updated', task })

    // Emit board.task_updated to subscribers
    if (boardSubscriptionService) {
      const payload = {
        taskId: task.taskId,
        taskTitle: task.title,
        assignedAgentId: task.assignedAgentId,
        tags: task.tags,
        columnId: task.columnId,
      }
      boardSubscriptionService.notifySubscribers(task.boardId, {
        eventType: 'board.task_updated',
        boardId: task.boardId,
        formattedMessage: BSS.formatEventMessage({ eventType: 'board.task_updated', boardId: task.boardId, payload }),
        payload,
      })
    }

    return { task }
  }
}
