/**
 * board.stop-task — Send a cooperative stop signal to a running task
 *
 * Sets stopRequested=true on the task and sends a system message to the
 * task's linked conversation. The runner agent reads this flag at the start
 * of each turn and stops gracefully.
 *
 * If the agent does not respond within STOP_TIMEOUT_MS (5 min), a warning
 * note is added and an event is emitted to board subscribers.
 *
 * Cooperative, not forced — the LLM cannot be interrupted mid-turn.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { EventHandler } from '../../event-handler'
import type { Db } from 'mongodb'

const STOP_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

interface StopTaskData {
  taskId: string
  reason?: string
  agentId?: string   // caller agent ID (for attribution)
}

export function createStopTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  eventHandler: EventHandler,
  db: Db,
  boardSubscriptionService?: BoardSubscriptionService,
) {
  return async function stopTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as StopTaskData
    const { taskId, reason, agentId } = data

    if (!taskId) throw new HandlerError('MISSING_FIELDS', 'taskId is required')

    const task = await boardService.getTask(taskId)
    if (!task) throw new HandlerError('NOT_FOUND', 'Task not found')

    if (!task.running) {
      throw new HandlerError(
        'INVALID_STATE',
        `Task is not currently running`,
      )
    }

    const board = await boardService.getBoard(task.boardId)
    const project = board ? await boardService.getProject(board.projectId) : null
    if (!project) throw new HandlerError('NOT_FOUND', 'Project not found')

    // Only managers can stop tasks
    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'Only managers can stop running tasks')
    }

    const now = new Date()
    const requestedBy = agentId ?? ctx.userId

    // Set stopRequested flag directly (bypasses UpdateTaskInput which doesn't have these fields)
    await db.collection('tasks').updateOne(
      { taskId },
      {
        $set: {
          stopRequested: true,
          stopRequestedAt: now.toISOString(),
          stopRequestedBy: requestedBy,
          updatedAt: now.toISOString(),
        },
        $push: {
          activity: {
            eventType: 'stop_requested',
            actor: requestedBy,
            timestamp: now.toISOString(),
            details: { reason: reason ?? 'No reason provided' },
          } as any,
        },
      },
    )

    // If task has a linked conversation, send a system message to the runner
    if (task.channelId) {
      const stopMessage =
        `⚠️ Stop requested by ${requestedBy}. Reason: ${reason ?? 'No reason provided'}.\n` +
        `Please finish your current step, move this task to the appropriate column (Blocked or Done), ` +
        `and add a progress note explaining where you left off.`

      await eventHandler.handleScheduledEvent({
        channelId: task.channelId,
        message: stopMessage,
        eventType: 'task_update',
        wakeUpAgent: false, // don't interrupt mid-turn; agent reads it on next turn
        metadata: {
          source: 'stop_task',
          boardTaskId: taskId,
          taskTitle: task.title,
        },
      })
    }

    // Schedule timeout: if agent hasn't responded in 5 min, emit a warning
    setTimeout(async () => {
      try {
        const current = await boardService.getTask(taskId)
        // If still stopRequested after timeout, the agent hasn't processed it
        if (current?.stopRequested) {
          const warningNote = `⚠️ Stop signal was sent but agent did not respond within 5 minutes. Task remains in working state.`

          await db.collection('tasks').updateOne(
            { taskId },
            {
              $push: {
                progressNotes: {
                  noteId: `pn_timeout_${Date.now()}`,
                  text: warningNote,
                  createdBy: 'system',
                  createdAt: new Date().toISOString(),
                } as any,
              },
            },
          )

          // Emit stop_timeout event to board subscribers
          if (boardSubscriptionService) {
            boardSubscriptionService.notifySubscribers(task.boardId, {
              eventType: 'board.task_moved',
              boardId: task.boardId,
              formattedMessage: `⚠️ Board event: stop_timeout\nTask "${task.title}" did not respond to stop signal within 5 minutes.`,
              payload: {
                taskId,
                taskTitle: task.title,
                assignedAgentId: task.assignedAgentId,
                columnId: task.columnId,
                tags: task.tags,
                previousStatus: 'working',
                newStatus: 'working',
              },
            })
          }
        }
      } catch (err) {
        console.error(`[stop-task] Timeout handler error for task ${taskId}:`, err)
      }
    }, STOP_TIMEOUT_MS)

    return {
      taskId,
      message: `Stop signal sent to task "${task.title}". The agent will finish its current step and stop.`,
    }
  }
}
