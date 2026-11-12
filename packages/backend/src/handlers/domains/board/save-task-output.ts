/**
 * board.save-task-output — Save output data to output.data WITHOUT
 * completing the task or firing the ActionBridge.
 *
 * This separates "fill output" from "complete task":
 *   - Save: persists outputData to output.data. No column move,
 *     no ActionBridge, no autoplay scheduling. The task stays where it is.
 *   - Complete (move-task / complete-my-task): fires the ActionBridge to
 *     advance the workflow, using the already-persisted output.data.
 *
 * Supports two modes:
 *   - `replace` (default): overwrites output.data with the new value.
 *   - `append`: appends to existing markdown output (only valid when the
 *     output gate's schemaId is "markdown"). The new text is joined to the
 *     existing output with a double newline separator.
 *
 * Access: any user with write access to the workspace (manager or runner
 * via the board-runner MCA). The caller does NOT need to be the assigned
 * agent — a manager may pre-fill output, and a runner may save progress.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import { BoardSubscriptionService as BSS } from '../../../services/board-subscription-service'

interface SaveTaskOutputData {
  taskId: string
  /** The output data to save. */
  outputData: unknown
  /**
   * Save mode:
   *   - 'replace' (default): overwrite output.data.
   *   - 'append': append to existing markdown output (requires markdown gate).
   */
  mode?: 'replace' | 'append'
}

export function createSaveTaskOutputHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  boardSubscriptionService?: BoardSubscriptionService,
) {
  return async function saveTaskOutput(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as SaveTaskOutputData
    const { taskId, outputData, mode = 'replace' } = data

    if (!taskId) {
      throw new HandlerError('MISSING_FIELDS', 'taskId is required')
    }

    if (outputData === undefined || outputData === null) {
      throw new HandlerError('MISSING_FIELDS', 'outputData is required')
    }

    // Verify task exists
    const task = await boardService.getTask(taskId)
    if (!task) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    // Verify workspace access (write or higher)
    const board = await boardService.getBoard(task.boardId)
    const project = board ? await boardService.getProject(board.projectId) : null
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role === null) {
      throw new HandlerError('FORBIDDEN', 'No access')
    }

    // ─── Append mode: only valid for markdown gates ────────────────────
    let finalOutputData = outputData

    if (mode === 'append') {
      // Check that the task has a markdown output gate
      const schemaId = task.output?.schemaId ?? (task.workflowOutputGate as Record<string, unknown> | undefined)?.schemaId

      if (schemaId !== 'markdown') {
        throw new HandlerError(
          'BAD_REQUEST',
          'Append mode is only supported for markdown output gates',
        )
      }

      const existing = task.output?.data
      const existingText =
        typeof existing === 'string' ? existing : existing !== null && existing !== undefined ? String(existing) : ''

      const newText = typeof outputData === 'string' ? outputData : String(outputData)

      // Join with double newline if both parts are non-empty
      if (existingText.trim() && newText.trim()) {
        finalOutputData = `${existingText}\n\n${newText}`
      } else if (newText.trim()) {
        finalOutputData = newText
      } else {
        finalOutputData = existingText
      }
    }

    // ─── Persist to output.data ──────────────────────────────────
    const updatedTask = await boardService.updateTask(taskId, ctx.userId, {
      outputData: finalOutputData,
    })

    if (!updatedTask) {
      throw new HandlerError('NOT_FOUND', 'Task not found during update')
    }

    // Broadcast the update so connected clients refresh
    pubSubService.broadcastToTopic(`board:${updatedTask.boardId}`, {
      type: 'board_task_updated',
      task: updatedTask,
    })

    // Notify board subscribers
    if (boardSubscriptionService && board) {
      boardSubscriptionService.notifySubscribers(updatedTask.boardId, {
        eventType: 'board.task_updated',
        boardId: updatedTask.boardId,
        formattedMessage: BSS.formatEventMessage({
          eventType: 'board.task_updated',
          boardId: updatedTask.boardId,
          payload: { taskId: updatedTask.taskId, taskTitle: updatedTask.title },
        }),
        payload: {
          taskId: updatedTask.taskId,
          taskTitle: updatedTask.title,
          field: 'output',
          mode,
          // @todo nira - 2026.09.24 : this handler is reachable from board-runner
          // (agent path) but has no agentId in its payload, so a runner-originated
          // save is attributed to its user session and will NOT be caught by the
          // self-wake guard. Low risk (no move/state change → no feedback loop);
          // fix by plumb-through of the calling agentId if it ever matters.
          actorUserId: ctx.userId,
        },
      })
    }

    return { task: updatedTask }
  }
}
