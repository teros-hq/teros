/**
 * board.add-my-progress-note — Add a progress note to a task assigned to the calling agent
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import { BoardSubscriptionService as BSS } from '../../../services/board-subscription-service'

interface AddMyProgressNoteData {
  taskId: string
  text: string
  agentId: string
}

export function createAddMyProgressNoteHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  boardSubscriptionService?: BoardSubscriptionService,
) {
  return async function addMyProgressNote(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as AddMyProgressNoteData
    const { taskId, text, agentId } = data

    if (!taskId || !text || !agentId) {
      throw new HandlerError('MISSING_FIELDS', 'taskId, text, and agentId are required')
    }

    // Verify task exists and is assigned to this agent
    const task = await boardService.getTask(taskId)
    if (!task) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    if (task.assignedAgentId !== agentId) {
      throw new HandlerError('FORBIDDEN', 'You can only add progress notes to tasks assigned to you')
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

    const updatedTask = await boardService.addProgressNote(taskId, text, agentId)
    if (!updatedTask) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    pubSubService.broadcastToTopic(`board:${updatedTask.boardId}`, { type: 'board_task_updated', task: updatedTask })

    // Emit board.task_progress_note to subscribers
    if (boardSubscriptionService) {
      const payload = {
        taskId: updatedTask.taskId,
        taskTitle: updatedTask.title,
        assignedAgentId: updatedTask.assignedAgentId,
        tags: updatedTask.tags,
        columnId: updatedTask.columnId,
        noteText: text,
      }
      boardSubscriptionService.notifySubscribers(updatedTask.boardId, {
        eventType: 'board.task_progress_note',
        boardId: updatedTask.boardId,
        formattedMessage: BSS.formatEventMessage({ eventType: 'board.task_progress_note', boardId: updatedTask.boardId, payload }),
        payload,
      })
    }

    return { task: updatedTask }
  }
}
