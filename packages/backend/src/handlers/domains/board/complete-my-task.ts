/**
 * board.complete-my-task — Runner action: mark task as complete (move to Review)
 *
 * Resolves the Review column by slug — the runner never handles columnIds.
 * Clears the running flag after moving.
 * Triggers autoplay scheduling (slot freed).
 *
 * Workflow hook: if the task has a workflowExecutionId, calls the ActionBridge
 * to advance the workflow engine. If the engine rejects the output (gate
 * validation fails), the bridge moves the task back to in_progress/blocked.
 *
 * Output data: the runner agent may pass `outputData` when completing a task.
 * If provided, it is persisted to `output.data` on the task document
 * BEFORE the ActionBridge fires, so the workflow engine receives the agent's
 * output for gate validation.
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
import type { ActionBridgeManager } from '../../../services/workflow-action-bridge'

interface CompleteMyTaskData {
  taskId: string
  agentId: string
  /** Optional output data produced by the agent (the deliverable). */
  outputData?: unknown
}

export function createCompleteMyTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  autoplayService?: AutoplayService,
  boardSubscriptionService?: BoardSubscriptionService,
  channelManager?: ChannelManager,
  eventHandler?: EventHandler,
  actionBridgeManager?: ActionBridgeManager,
) {
  return async function completeMyTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CompleteMyTaskData
    const { taskId, agentId, outputData } = data

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
    const afterRunning = await boardService.setRunning(taskId, false, agentId)
    const afterStopClear = await boardService.clearStopRequest(taskId)
    let updatedTask = afterStopClear ?? afterRunning ?? moved

    // ──────────────────────────────────────────────────────────────
    // Persist agent-provided output data to output.data BEFORE
    // the ActionBridge fires. This ensures the workflow engine receives
    // the agent's deliverable for gate validation.
    // ──────────────────────────────────────────────────────────────
    if (outputData !== undefined && outputData !== null) {
      const withOutput = await boardService.updateTask(taskId, agentId, {
        outputData,
      })
      if (withOutput) {
        updatedTask = withOutput
      }
    }

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
        actorAgentId: agentId,
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

    // ──────────────────────────────────────────────────────────────
    // Workflow hook: if this task was created by a workflow execution,
    // notify the ActionBridge to advance the workflow engine.
    // The bridge reads outputData from the event — which now
    // includes the agent-provided outputData persisted above.
    // ──────────────────────────────────────────────────────────────
    if (actionBridgeManager && updatedTask.workflowExecutionId) {
      try {
        const result = await actionBridgeManager.onTaskCompleted(project.projectId, {
          taskId: updatedTask.taskId,
          status: 'review',
          workflowExecutionId: updatedTask.workflowExecutionId,
          workflowNodeId: updatedTask.workflowNodeId,
          outputData: updatedTask.output?.data,
        })

        if (result.rejected) {
          // The bridge moved the task back to in_progress/blocked.
          // Re-fetch the task to get the updated state.
          const rejectedTask = await boardService.getTask(taskId)
          if (rejectedTask) {
            updatedTask = rejectedTask
          }
          console.log(`[complete-my-task] Workflow rejected task ${taskId} — moved back for revision`)
        }
      } catch (err) {
        // Workflow hook failure must not break the completion flow.
        // The task is already in Review; the workflow will need manual intervention.
        console.error('[complete-my-task] Workflow advancement failed:', err)
      }
    }

    return { task: updatedTask }
  }
}
