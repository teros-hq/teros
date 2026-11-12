/**
 * board.get-task — Get full task details including sub-tasks
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import { TASK_LIST_PROJECTION } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import { enrichTaskWithColumn, enrichTasksWithColumns } from './_helpers'

interface GetTaskData {
  taskId: string
}

export function createGetTaskHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
) {
  return async function getTask(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetTaskData
    const { taskId } = data

    if (!taskId) {
      throw new HandlerError('MISSING_FIELDS', 'taskId is required')
    }

    const task = await boardService.getTask(taskId)
    if (!task) {
      throw new HandlerError('NOT_FOUND', 'Task not found')
    }

    // Verify workspace access via board → project → workspace
    const board = await boardService.getBoard(task.boardId)
    if (!board) {
      throw new HandlerError('NOT_FOUND', 'Board not found')
    }
    const project = await boardService.getProject(board.projectId)
    if (!project) {
      throw new HandlerError('NOT_FOUND', 'Project not found')
    }
    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role === null) {
      throw new HandlerError('FORBIDDEN', 'No access')
    }

    // Get sub-tasks and the parent title.
    // The MAIN task (from getTask above) is returned complete — instructions,
    // progressNotes, activity, input/output all included; that is the detail
    // view. But resolving sub-tasks/parent-title does NOT need every board
    // task's heavy fields: TASK_LIST_PROJECTION keeps this handler fast on
    // large boards (it previously shipped the entire board to find a handful
    // of sub-tasks). Sub-tasks render as light rows in the UI; their full
    // content is available by calling get-task on the sub-task itself.
    const allTasks = await boardService.listTasks(task.boardId, {
      projection: TASK_LIST_PROJECTION,
    })
    const subTasks = allTasks.filter((t) => t.parentTaskId === taskId)

    // Resolve parent task title if this is a sub-task
    let parentTaskTitle: string | undefined
    if (task.parentTaskId) {
      const parent = allTasks.find((t) => t.taskId === task.parentTaskId)
      parentTaskTitle = parent?.title
    }

    const enrichedTask = enrichTaskWithColumn(task, board)
    const enrichedSubTasks = enrichTasksWithColumns(subTasks, board)

    // Resolve agent names/avatars
    const agentIds = boardService.collectAgentIds([task, ...subTasks])
    const agents = await boardService.resolveAgents(agentIds)

    return {
      task: { ...enrichedTask, ...(parentTaskTitle ? { parentTaskTitle } : {}), projectId: project.projectId, projectName: project.name },
      subTasks: enrichedSubTasks,
      agents,
    }
  }
}
