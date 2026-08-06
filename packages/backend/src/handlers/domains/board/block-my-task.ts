/**
 * board.block-my-task — Runner action: mark task as blocked (move to Blocked)
 *
 * Resolves the Blocked column by slug — the runner never handles columnIds.
 * Adds a progress note with the reason.
 * Clears the running flag after moving.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import { BoardSubscriptionService as BSS } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'

interface BlockMyTaskData {
  taskId: string
  reason: string
  agentId: string
}

export function createBlockMyTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  boardSubscriptionService?: BoardSubscriptionService,
) {
  return async function blockMyTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as BlockMyTaskData
    const { taskId, reason, agentId } = data

    if (!taskId || !reason || !agentId) {
      throw new HandlerError('MISSING_FIELDS', 'taskId, reason, and agentId are required')
    }

    // Verify task exists and is assigned to this agent
    const task = await boardService.getTask(taskId)
    if (!task) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    if (task.assignedAgentId !== agentId) {
      throw new HandlerError('FORBIDDEN', 'You can only block tasks assigned to you')
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

    // Resolve the Blocked column by slug
    const blockedColumn = board!.columns.find((c) => c.slug === 'blocked')
    if (!blockedColumn) {
      throw new HandlerError('NOT_FOUND', 'Blocked column not found on this board')
    }

    const fromColumn = board!.columns.find((c) => c.columnId === task.columnId)

    // Add progress note with the reason first
    await boardService.addProgressNote(taskId, `🚧 Blocked: ${reason}`, agentId)

    // Move to Blocked column
    const moved = await boardService.moveTask(taskId, agentId, blockedColumn.columnId)
    if (!moved) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    // Clear running flag. Use the return of setRunning so `running: false`
    // is reflected in the response (setRunning is a no-op + returns null if
    // already false — fall back to the moved task).
    const afterRunning = await boardService.setRunning(taskId, false)
    const updatedTask = afterRunning ?? moved

    pubSubService.broadcastToTopic(`board:${updatedTask.boardId}`, { type: 'board_task_updated', task: updatedTask })

    // Emit board.task_moved to subscribers
    if (boardSubscriptionService && board) {
      const payload = {
        taskId: updatedTask.taskId,
        taskTitle: updatedTask.title,
        assignedAgentId: updatedTask.assignedAgentId,
        tags: updatedTask.tags,
        fromColumnId: task.columnId,
        fromColumnName: fromColumn?.name,
        toColumnId: blockedColumn.columnId,
        toColumnName: blockedColumn.name,
        columnId: blockedColumn.columnId,
      }
      boardSubscriptionService.notifySubscribers(updatedTask.boardId, {
        eventType: 'board.task_moved',
        boardId: updatedTask.boardId,
        formattedMessage: BSS.formatEventMessage({ eventType: 'board.task_moved', boardId: updatedTask.boardId, payload }),
        payload,
      })
    }

    return { task: updatedTask }
  }
}
