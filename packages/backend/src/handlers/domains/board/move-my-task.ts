/**
 * board.move-my-task — Move a task assigned to the calling agent
 *
 * Triggers autoplay scheduling when:
 * - Task moves to Review or Done (slot freed)
 * - Task moves to To Do (new eligible task)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import { BoardSubscriptionService as BSS } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { AutoplayService } from '../../../services/autoplay-service'

interface MoveMyTaskData {
  taskId: string
  columnId: string
  position?: number
  agentId: string
}

export function createMoveMyTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  autoplayService?: AutoplayService,
  boardSubscriptionService?: BoardSubscriptionService,
) {
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

    const fromColumn = board?.columns.find((c) => c.columnId === task.columnId)
    const updatedTask = await boardService.moveTask(taskId, agentId, columnId, position)
    if (!updatedTask) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    pubSubService.broadcastToTopic(`board:${updatedTask.boardId}`, { type: 'board_task_updated', task: updatedTask })

    // Clear stopRequested when runner moves the task (they processed the signal)
    if (task.stopRequested && updatedTask.stopRequested) {
      await boardService.updateTask(taskId, agentId, { stopRequested: false, stopRequestedAt: undefined, stopRequestedBy: undefined } as any)
    }

    // Emit board.task_moved to subscribers
    if (boardSubscriptionService && board) {
      const toColumn = board.columns.find((c) => c.columnId === columnId)
      const payload = {
        taskId: updatedTask.taskId,
        taskTitle: updatedTask.title,
        assignedAgentId: updatedTask.assignedAgentId,
        tags: updatedTask.tags,
        fromColumnId: task.columnId,
        fromColumnName: fromColumn?.name,
        toColumnId: columnId,
        toColumnName: toColumn?.name,
        columnId,
      }
      boardSubscriptionService.notifySubscribers(updatedTask.boardId, {
        eventType: 'board.task_moved',
        boardId: updatedTask.boardId,
        formattedMessage: BSS.formatEventMessage({ eventType: 'board.task_moved', boardId: updatedTask.boardId, payload }),
        payload,
      })
    }

    // Trigger autoplay scheduling based on destination column
    if (autoplayService && board) {
      const targetCol = board.columns.find((c) => c.columnId === columnId)
      if (targetCol) {
        const slug = targetCol.slug
        // Slot freed: Review or Done; new eligible: To Do
        if (slug === 'review' || slug === 'done' || slug === 'todo') {
          autoplayService.scheduleAgentTasks(project.projectId, agentId)
        }
      }
    }

    return { task: updatedTask }
  }
}
