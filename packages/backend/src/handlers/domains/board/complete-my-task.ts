/**
 * board.complete-my-task — Runner action: mark task as complete (move to Review)
 *
 * Resolves the Review column by slug — the runner never handles columnIds.
 * Clears the running flag after moving.
 * Triggers autoplay scheduling (slot freed).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import { BoardSubscriptionService as BSS } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { AutoplayService } from '../../../services/autoplay-service'
import type { ChannelManager } from '../../../services/channel-manager'
import type { EventHandler } from '../../event-handler'

interface CompleteMyTaskData {
  taskId: string
  agentId: string
}

export function createCompleteMyTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  autoplayService?: AutoplayService,
  boardSubscriptionService?: BoardSubscriptionService,
  channelManager?: ChannelManager,
  eventHandler?: EventHandler,
) {
  return async function completeMyTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CompleteMyTaskData
    const { taskId, agentId } = data

    if (!taskId || !agentId) {
      throw new HandlerError('MISSING_FIELDS', 'taskId and agentId are required')
    }

    // Verify task exists and is assigned to this agent
    const task = await boardService.getTask(taskId)
    if (!task) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    if (task.assignedAgentId !== agentId) {
      throw new HandlerError('FORBIDDEN', 'You can only complete tasks assigned to you')
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

    // Resolve the Review column by slug
    const reviewColumn = board!.columns.find((c) => c.slug === 'review')
    if (!reviewColumn) {
      throw new HandlerError('NOT_FOUND', 'Review column not found on this board')
    }

    const fromColumn = board!.columns.find((c) => c.columnId === task.columnId)
    const moved = await boardService.moveTask(taskId, agentId, reviewColumn.columnId)
    if (!moved) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    // Clear running flag + stop request. Task is now in Review so the
    // cooperative stop signal is resolved. Chain updates and return the
    // latest state (each helper returns null when it's a no-op, so fall
    // back through the chain).
    const afterRunning = await boardService.setRunning(taskId, false)
    const afterStopClear = await boardService.clearStopRequest(taskId)
    const updatedTask = afterStopClear ?? afterRunning ?? moved

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
        toColumnId: reviewColumn.columnId,
        toColumnName: reviewColumn.name,
        columnId: reviewColumn.columnId,
      }
      boardSubscriptionService.notifySubscribers(updatedTask.boardId, {
        eventType: 'board.task_moved',
        boardId: updatedTask.boardId,
        formattedMessage: BSS.formatEventMessage({ eventType: 'board.task_moved', boardId: updatedTask.boardId, payload }),
        payload,
      })
    }

    // Slot freed — trigger autoplay for next eligible task
    if (autoplayService) {
      autoplayService.scheduleAgentTasks(project.projectId, agentId)
    }

    // TER-352: notify the parent channel (originChannelId) that the sub-canal
    // del runner ha completado su tarea. Sin esto el manager humano queda
    // esperando sin enterarse — descubierto en smoke del PR #103.
    if (eventHandler && channelManager && updatedTask.originChannelId && updatedTask.channelId) {
      try {
        const subChannel = await channelManager.getChannel(updatedTask.channelId)
        const observedChannelName = subChannel?.metadata?.name || updatedTask.title || updatedTask.channelId
        await eventHandler.handleScheduledEvent({
          channelId: updatedTask.originChannelId,
          message: `${observedChannelName} finished`,
          eventType: 'channel_finished',
          metadata: {
            observedChannelId: updatedTask.channelId,
            observedChannelName,
            taskId: updatedTask.taskId,
            taskTitle: updatedTask.title,
          },
        })
      } catch (err) {
        console.error('[complete-my-task] Failed to emit channel_finished event:', err)
      }
    }

    return { task: updatedTask }
  }
}
