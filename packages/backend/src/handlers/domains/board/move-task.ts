/**
 * board.move-task — Move a task to a different column
 *
 * Triggers autoplay scheduling when:
 * - Task moves to Review or Done (slot freed for agent)
 * - Task moves to To Do (new eligible task for agent)
 *
 * Workflow hook: when a task is moved to 'review' or 'done' and has a
 * workflowExecutionId, calls the ActionBridge to advance the workflow engine.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import { BoardSubscriptionService as BSS } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { AutoplayService } from '../../../services/autoplay-service'
import type { ActionBridgeManager } from '../../../services/workflow-action-bridge'

interface MoveTaskData {
  taskId: string
  columnId: string
  position?: number
  /** Optional output data produced by a human completing a workflow task. */
  outputData?: unknown
}

export function createMoveTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  autoplayService?: AutoplayService,
  boardSubscriptionService?: BoardSubscriptionService,
  actionBridgeManager?: ActionBridgeManager,
) {
  return async function moveTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as MoveTaskData
    const { taskId, columnId, position, outputData } = data

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
        actorUserId: ctx.userId,
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

    // ──────────────────────────────────────────────────────────────
    // Persist human-provided output data to output.data BEFORE
    // the ActionBridge fires. This ensures the workflow engine receives
    // the human's deliverable for gate validation — same pattern as
    // complete-my-task.ts.
    // ──────────────────────────────────────────────────────────────
    if (outputData !== undefined && outputData !== null) {
      const withOutput = await boardService.updateTask(taskId, ctx.userId, {
        outputData,
      })
      if (withOutput) {
        // Update the local reference so the workflow hook below sees
        // the freshly persisted output data.
        task.output = withOutput.output
      }
    }

    // ──────────────────────────────────────────────────────────────
    // Workflow hook: if this task was created by a workflow execution
    // and is being moved to 'review' or 'done', notify the ActionBridge
    // to advance the workflow engine.
    // ──────────────────────────────────────────────────────────────
    if (actionBridgeManager && task.workflowExecutionId && board) {
      const targetCol = board.columns.find((c) => c.columnId === columnId)
      const targetSlug = targetCol?.slug
      if (targetSlug === 'review' || targetSlug === 'done') {
        try {
          const result = await actionBridgeManager.onTaskCompleted(project.projectId, {
            taskId: task.taskId,
            status: targetSlug,
            workflowExecutionId: task.workflowExecutionId,
            workflowNodeId: task.workflowNodeId,
            outputData: task.output?.data,
          })

          if (result.rejected) {
            // The bridge moved the task back to in_progress/blocked.
            // Re-fetch the task to get the updated state.
            const rejectedTask = await boardService.getTask(taskId)
            if (rejectedTask) {
              return { task: rejectedTask }
            }
          }
        } catch (err) {
          // Workflow hook failure must not break the move flow.
          console.error('[move-task] Workflow advancement failed:', err)
        }
      }
    }

    return { task }
  }
}
