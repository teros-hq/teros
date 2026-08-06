/**
 * board.create-task — Create a task in a project's board
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService, CreateTaskInput } from '../../../services/board-service'
import type { BoardSubscriptionService } from '../../../services/board-subscription-service'
import { BoardSubscriptionService as BSS } from '../../../services/board-subscription-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'

interface CreateTaskData extends CreateTaskInput {
  projectId: string
}

export function createCreateTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  boardSubscriptionService?: BoardSubscriptionService,
) {
  return async function createTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as CreateTaskData
    const { projectId, ...taskInput } = data

    if (!projectId || !taskInput.title) {
      throw new HandlerError('MISSING_FIELDS', 'projectId and title are required')
    }

    const project = await boardService.getProject(projectId)
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role !== 'owner' && role !== 'admin' && role !== 'write') {
      throw new HandlerError('FORBIDDEN', 'No write access')
    }

    const task = await boardService.createTask(project.boardId, ctx.userId, taskInput)

    pubSubService.broadcastToTopic(`board:${project.boardId}`, { type: 'board_task_created', task })

    // Emit board.task_created to subscribers
    if (boardSubscriptionService) {
      const board = await boardService.getBoard(project.boardId)
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

    return { task }
  }
}
