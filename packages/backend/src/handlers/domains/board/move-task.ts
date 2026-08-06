/**
 * board.move-task — Move a task to a different column
 *
 * Triggers autoplay scheduling when:
 * - Task moves to Review or Done (slot freed for agent)
 * - Task moves to To Do (new eligible task for agent)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import { BoardSubscriptionService as BSS } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { AutoplayService } from '../../../services/autoplay-service'

interface MoveTaskData {
  taskId: string
  columnId: string
  position?: number
}

export function createMoveTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  autoplayService?: AutoplayService,
  boardSubscriptionService?: BoardSubscriptionService,
) {
  return async function moveTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as MoveTaskData
    const { taskId, columnId, position } = data

    if (!taskId || !columnId) {
      throw new HandlerError('MISSING_FIELDS', 'taskId and columnId are required')
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

    const fromColumn = board?.columns.find((c) => c.columnId === existing.columnId)
    const task = await boardService.moveTask(taskId, ctx.userId, columnId, position)
    if (!task) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    pubSubService.broadcastToTopic(`board:${task.boardId}`, { type: 'board_task_updated', task })

    // Emit board.task_moved to subscribers
    if (boardSubscriptionService && board) {
      const toColumn = board.columns.find((c) => c.columnId === columnId)
      const payload = {
        taskId: task.taskId,
        taskTitle: task.title,
        assignedAgentId: task.assignedAgentId,
        tags: task.tags,
        fromColumnId: existing.columnId,
        fromColumnName: fromColumn?.name,
        toColumnId: columnId,
        toColumnName: toColumn?.name,
        columnId,
      }
      boardSubscriptionService.notifySubscribers(task.boardId, {
        eventType: 'board.task_moved',
        boardId: task.boardId,
        formattedMessage: BSS.formatEventMessage({ eventType: 'board.task_moved', boardId: task.boardId, payload }),
        payload,
      })
    }

    // Trigger autoplay scheduling based on destination column
    if (autoplayService && task.assignedAgentId && board) {
      const targetCol = board.columns.find((c) => c.columnId === columnId)
      if (targetCol) {
        const slug = targetCol.slug
        if (slug === 'review' || slug === 'done' || slug === 'todo') {
          autoplayService.scheduleAgentTasks(project.projectId, task.assignedAgentId)
        }
      }
    }

    return { task }
  }
}
