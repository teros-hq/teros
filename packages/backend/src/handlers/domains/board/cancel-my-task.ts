/**
 * board.cancel-my-task — Runner action: cancel a task (archive in-place)
 *
 * Archives the task without moving it to a different column.
 * Adds a progress note with the reason.
 * Clears the running flag.
 * Works from any column.
 *
 * When the cancelled task has dependents (tasks that listed it as a dependency):
 *   1. Adds a warning progress note to each dependent task.
 *   2. Notifies the supervision channel (if project.autorun.supervisionChannelId exists).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { EventHandler } from '../../event-handler'

interface CancelMyTaskData {
  taskId: string
  reason: string
  agentId: string
}

export function createCancelMyTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  boardSubscriptionService?: BoardSubscriptionService,
  eventHandler?: EventHandler,
) {
  return async function cancelMyTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CancelMyTaskData
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
      throw new HandlerError('FORBIDDEN', 'You can only cancel tasks assigned to you')
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

    // Add progress note with the reason first
    await boardService.addProgressNote(taskId, `❌ Cancelled: ${reason}`, agentId)

    // Clear running flag + stop request before archiving. Both flags no
    // longer apply to an archived task, and archiveTask below returns the
    // final state so there is no shape discrepancy.
    await boardService.setRunning(taskId, false)
    await boardService.clearStopRequest(taskId)

    // Archive the task in-place (no column move)
    const archiveNote = `Cancelled by runner: ${reason}`
    const updatedTask = await boardService.archiveTask(taskId, agentId, archiveNote)
    if (!updatedTask) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    pubSubService.broadcastToTopic(`board:${updatedTask.boardId}`, { type: 'board_task_updated', task: updatedTask })

    // Emit board.task_archived to subscribers
    if (boardSubscriptionService) {
      boardSubscriptionService.notifySubscribers(updatedTask.boardId, {
        eventType: 'board.task_archived',
        boardId: updatedTask.boardId,
        formattedMessage: `📋 Board event: task_archived\nTask "${updatedTask.title}": cancelled by runner — ${reason}`,
        payload: {
          taskId: updatedTask.taskId,
          taskTitle: updatedTask.title,
          assignedAgentId: updatedTask.assignedAgentId,
          tags: updatedTask.tags,
          columnId: updatedTask.columnId,
          archived: true,
          reason,
        },
      })
    }

    // ── Notify dependent tasks ──────────────────────────────────────────────
    // Find all active tasks in the same board that listed this task as a dependency
    const dependentTasks = await boardService.getDependentTasks(taskId, updatedTask.boardId)

    if (dependentTasks.length > 0) {
      const warningNote =
        `⚠️ La tarea '${updatedTask.title}' de la que dependías fue cancelada. ` +
        `Revisa si esta tarea sigue siendo necesaria.`

      // Add a warning progress note to each dependent task
      for (const dep of dependentTasks) {
        await boardService.addProgressNote(dep.taskId, warningNote, agentId)
        // Broadcast the updated dependent task so the board UI refreshes
        const updatedDep = await boardService.getTask(dep.taskId)
        if (updatedDep) {
          pubSubService.broadcastToTopic(`board:${updatedDep.boardId}`, { type: 'board_task_updated', task: updatedDep })
          // Also emit a board subscription event
          if (boardSubscriptionService) {
            boardSubscriptionService.notifySubscribers(updatedDep.boardId, {
              eventType: 'board.task_progress_note',
              boardId: updatedDep.boardId,
              formattedMessage: `📋 Board event: task_progress_note\nTask "${updatedDep.title}": ${warningNote}`,
              payload: {
                taskId: updatedDep.taskId,
                taskTitle: updatedDep.title,
                assignedAgentId: updatedDep.assignedAgentId,
                tags: updatedDep.tags,
                columnId: updatedDep.columnId,
                note: warningNote,
              },
            })
          }
        }
      }

      // Notify the supervision channel if one is configured
      const supervisionChannelId = (project as any).autorun?.supervisionChannelId as string | undefined
      if (supervisionChannelId && eventHandler) {
        const orphanList = dependentTasks
          .map((d) => `• "${d.title}" (${d.taskId})`)
          .join('\n')
        const supervisionMessage =
          `⚠️ La tarea "${updatedTask.title}" (${taskId}) fue **cancelada** por el runner.\n\n` +
          `Las siguientes tareas dependían de ella y ahora están huérfanas:\n${orphanList}\n\n` +
          `Revisa si deben continuar, reasignarse o cancelarse.`

        await eventHandler.handleScheduledEvent({
          channelId: supervisionChannelId,
          message: supervisionMessage,
          eventType: 'task.dependency_cancelled',
          wakeUpAgent: true,
          metadata: {
            boardTaskId: taskId,
            taskTitle: updatedTask.title,
            agentId,
            projectId: project.projectId,
            source: 'board-cancel',
            orphanTaskIds: dependentTasks.map((d) => d.taskId),
          },
        })
      }
    }

    return { task: updatedTask }
  }
}
