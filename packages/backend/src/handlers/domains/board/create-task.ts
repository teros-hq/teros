/**
 * board.create-task — Create a task in a project's board
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService, CreateTaskInput } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { SessionManager } from '../../../services/session-manager'

interface CreateTaskData extends CreateTaskInput {
  projectId: string
}

export function createCreateTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  sessionManager: SessionManager,
) {
  function broadcastBoardEvent(boardId: string, event: Record<string, any>): void {
    const subscribers = sessionManager.getBoardSubscribers(boardId)
    if (subscribers.length === 0) return
    const payload = JSON.stringify(event)
    for (const session of subscribers) {
      if (session.ws && session.ws.readyState === 1) {
        session.ws.send(payload)
      }
    }
  }

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

    broadcastBoardEvent(project.boardId, { type: 'board_task_created', task })

    return { task }
  }
}
