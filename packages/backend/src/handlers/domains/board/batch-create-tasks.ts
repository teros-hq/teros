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
import type { AgentProjectRelationship } from '../../../types/database'
import type { Db } from 'mongodb'

interface BatchCreateTasksData {
  projectId: string
  tasks: CreateTaskInput[]
}

export function createBatchCreateTasksHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  pubSubService: PubSubService,
  boardSubscriptionService?: BoardSubscriptionService,
  db?: Db,
) {
  return async function batchCreateTasks(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as BatchCreateTasksData
    const { projectId, tasks: taskInputs } = data

    if (!projectId || !taskInputs || !Array.isArray(taskInputs)) {
      throw new HandlerError('MISSING_FIELDS', 'projectId and tasks array are required')
    }
    // Validate every task has instructions
    for (let i = 0; i < taskInputs.length; i++) {
      const t = taskInputs[i]
      if (!t?.instructions || t.instructions.trim().length === 0) {
        throw new HandlerError('MISSING_FIELDS', `Task at index ${i} is missing required "instructions" — provide detailed task instructions so the assigned agent can work autonomously`)
      }
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

    pubSubService.broadcastToTopic(`board:${project.boardId}`, { type: 'board_tasks_batch_created', tasks, boardId: project.boardId })

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
          actorUserId: ctx.userId,
        }
        boardSubscriptionService.notifySubscribers(project.boardId, {
          eventType: 'board.task_created',
          boardId: project.boardId,
          formattedMessage: BSS.formatEventMessage({ eventType: 'board.task_created', boardId: project.boardId, payload }),
          payload,
        })
      }
    }

    // Build agent status for assigned agents (only if db is available)
    const assignedAgentIds = [...new Set(tasks.map((t) => t.assignedAgentId).filter(Boolean))] as string[]
    let agentStatuses: Array<{
      agentId: string
      agentName: string
      slots: number
      playEnabled: boolean
      activeSlots: number
      tasksToDo: number
      willAutoStart: boolean
    }> = []

    if (assignedAgentIds.length > 0 && db) {
      const relationships = await db
        .collection<AgentProjectRelationship>('agent_project_relationships')
        .find({ projectId: project.projectId, agentId: { $in: assignedAgentIds } })
        .toArray()

      if (relationships.length > 0) {
        // Fetch all board tasks once and reuse for every agent.
        // Only the fields the agent statuses read (assignedAgentId, running,
        // columnId) — full docs would ship the whole board for counts.
        const allBoardTasks = await boardService.listTasks(project.boardId, {
          projection: { _id: 0, assignedAgentId: 1, running: 1, columnId: 1 },
        })
        const board = await boardService.getBoard(project.boardId)
        const todoCol = board?.columns.find((c) => c.slug === 'todo')

        agentStatuses = await Promise.all(
          relationships.map(async (rel) => {
            const agentDoc = await db.collection('agents').findOne({ agentId: rel.agentId })
            const runningTasks = allBoardTasks.filter((t) => t.assignedAgentId === rel.agentId && t.running)
            const todoTasks = todoCol
              ? allBoardTasks.filter((t) => t.assignedAgentId === rel.agentId && t.columnId === todoCol.columnId).length
              : 0

            return {
              agentId: rel.agentId,
              agentName: (agentDoc?.name as string | undefined) ?? rel.agentId,
              slots: rel.slots,
              playEnabled: rel.playEnabled,
              activeSlots: runningTasks.length,
              tasksToDo: todoTasks,
              willAutoStart: rel.playEnabled && rel.slots > 0 && runningTasks.length < rel.slots,
            }
          }),
        )
      }
    }

    const response: { projectId: string; tasks: typeof tasks; count: number; agents?: typeof agentStatuses } = {
      projectId,
      tasks,
      count: tasks.length,
    }
    if (agentStatuses.length > 0) {
      response.agents = agentStatuses
    }
    return response
  }
}
