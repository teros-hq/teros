/**
 * board.archive-task — Archive or unarchive a task (manager action)
 *
 * Sets archived=true/false on a task. Archived tasks are out of the active board.
 * Triggers autoplay scheduling when a task is unarchived (slot potentially freed).
 */
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { AutoplayService } from '../../../services/autoplay-service'

interface ArchiveTaskData {
  taskId: string
  archived: boolean
  archiveNote?: string
  actor?: string
}

export function createArchiveTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  autoplayService?: AutoplayService,
  boardSubscriptionService?: BoardSubscriptionService,
) {
  return async function archiveTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ArchiveTaskData
    const { taskId, archived, archiveNote, actor } = data

    if (!taskId || archived === undefined) {
      throw new HandlerError('MISSING_FIELDS', 'taskId and archived are required')
    }

    const existing = await boardService.getTask(taskId)
    if (!existing) throw new HandlerError('NOT_FOUND', 'Task not found')

    const board = await boardService.getBoard(existing.boardId)
    const project = board ? await boardService.getProject(board.projectId) : null
    if (!project) throw new HandlerError('NOT_FOUND', 'Project not found')

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'No write access')
    }

    const result = archived
      ? await boardService.archiveTask(taskId, actor || ctx.userId, archiveNote)
      : await boardService.unarchiveTask(taskId, actor || ctx.userId)

    if (!result) throw new HandlerError('NOT_FOUND', 'Task not found')

    pubSubService.broadcastToTopic(`board:${result.boardId}`, { type: 'board_task_updated', task: result })

    if (boardSubscriptionService) {
      const payload = {
        taskId: result.taskId,
        taskTitle: result.title,
        assignedAgentId: result.assignedAgentId,
        tags: result.tags,
        columnId: result.columnId,
        archived,
      }
      boardSubscriptionService.notifySubscribers(result.boardId, {
        eventType: 'board.task_archived',
        boardId: result.boardId,
        formattedMessage: `📋 Board event: task_archived\nTask "${result.title}": ${archived ? 'archived' : 'unarchived'}`,
        payload,
      })
    }

    // Trigger autoplay when unarchiving (slot freed for deps)
    if (autoplayService && !archived && result.assignedAgentId) {
      autoplayService.scheduleAgentTasks(project.projectId, result.assignedAgentId)
    }

    return { task: result }
  }
}
