/**
 * board.get-board-status — Get operational status of a board
 *
 * Returns per-agent workload (slots, play, active tasks) and a board summary
 * (task counts by column and status, list of blocked tasks).
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { AgentProjectRelationship } from '../../../types/database'
import type { Db } from 'mongodb'

interface GetBoardStatusData {
  boardId: string
}

export function createGetBoardStatusHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  db: Db,
) {
  return async function getBoardStatus(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetBoardStatusData
    const { boardId } = data

    if (!boardId) throw new HandlerError('MISSING_FIELDS', 'boardId is required')

    const board = await boardService.getBoard(boardId)
    if (!board) throw new HandlerError('NOT_FOUND', 'Board not found')

    const project = await boardService.getProject(board.projectId)
    if (!project) throw new HandlerError('NOT_FOUND', 'Project not found')

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role === null) throw new HandlerError('FORBIDDEN', 'No access to this board')

    // All non-archived tasks on this board
    const allTasks = await boardService.listTasks(boardId)

    // Column lookup map
    const colMap = new Map(board.columns.map((c) => [c.columnId, c]))
    const blockedCol = board.columns.find((c) => c.slug === 'blocked')

    // Summary: counts by column
    const byColumn: Record<string, number> = {}
    for (const task of allTasks) {
      const colName = colMap.get(task.columnId)?.name ?? task.columnId
      byColumn[colName] = (byColumn[colName] ?? 0) + 1
    }

    // Blocked tasks detail
    const blockedTasks = blockedCol
      ? allTasks
          .filter((t) => t.columnId === blockedCol.columnId)
          .map((t) => ({
            taskId: t.taskId,
            title: t.title,
            assignedAgentId: t.assignedAgentId,
            lastProgressNote: t.progressNotes.length > 0
              ? t.progressNotes[t.progressNotes.length - 1].text
              : undefined,
          }))
      : []

    // Per-agent stats — load all relationships for this project
    const relationships = await db
      .collection<AgentProjectRelationship>('agent_project_relationships')
      .find({ projectId: project.projectId })
      .toArray()

    // Discover column IDs for per-agent counts
    const inProgressCol = board.columns.find((c) => c.slug === 'in_progress')
    const reviewCol = board.columns.find((c) => c.slug === 'review')
    const todoCol = board.columns.find((c) => c.slug === 'todo')

    const agentStats = await Promise.all(
      relationships.map(async (rel) => {
        const agentTasks = allTasks.filter((t) => t.assignedAgentId === rel.agentId)

        // Try to get agent name from DB
        const agentDoc = await db.collection('agents').findOne({ agentId: rel.agentId })

        return {
          agentId: rel.agentId,
          agentName: (agentDoc?.name as string | undefined) ?? rel.agentId,
          slots: rel.slots,
          playEnabled: rel.playEnabled,
          activeSlots: agentTasks.filter((t) => t.running).length,
          tasksInReview: reviewCol
            ? agentTasks.filter((t) => t.columnId === reviewCol.columnId).length
            : 0,
          tasksToDo: todoCol
            ? agentTasks.filter((t) => t.columnId === todoCol.columnId).length
            : 0,
          tasksBlocked: blockedCol
            ? agentTasks.filter((t) => t.columnId === blockedCol.columnId).length
            : 0,
        }
      }),
    )

    return {
      boardId,
      boardName: project.name,
      agents: agentStats,
      summary: {
        totalTasks: allTasks.length,
        byColumn,
        blockedTasks,
      },
    }
  }
}
