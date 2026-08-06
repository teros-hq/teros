/**
 * board.batch-create-tasks — Create multiple tasks atomically
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService, CreateTaskInput } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import { BoardSubscriptionService as BSS } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'

interface BatchCreateTasksData {
  projectId: string
  tasks: CreateTaskInput[]
}

export function createBatchCreateTasksHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  boardSubscriptionService?: BoardSubscriptionService,
) {
  return async function batchCreateTasks(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as BatchCreateTasksData
    const { projectId, tasks: taskInputs } = data

    if (!projectId || !taskInputs || !Array.isArray(taskInputs)) {
      throw new HandlerError('MISSING_FIELDS', 'projectId and tasks array are required')
    }

    const project = await boardService.getProject(projectId)
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'No write access')
    }

    const tasks = await boardService.batchCreateTasks(project.boardId, ctx.userId, taskInputs)

    pubSubService.broadcastToTopic(`board:${project.boardId}`, { type: 'board_tasks_batch_created', tasks })

    // Emit board.task_created for each created task
    if (boardSubscriptionService && tasks.length > 0) {
      const board = await boardService.getBoard(project.boardId)
      for (const task of tasks) {
        const column = board?.columns.find((c) => c.columnId === task.columnId)
        const payload = {
          taskId: task.taskId,
          taskTitle: task.title,
          assignedAgentId: task.assignedAgentId,
          tags: task.tags,
          columnId: task.columnId,
          columnName: column?.name,
        }
        boardSubscriptionService.notifySubscribers(project.boardId, {
          eventType: 'board.task_created',
          boardId: project.boardId,
          formattedMessage: BSS.formatEventMessage({ eventType: 'board.task_created', boardId: project.boardId, payload }),
          payload,
        })
      }
    }

    return { projectId, tasks, count: tasks.length }
  }
}
