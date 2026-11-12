/**
 * board.get-board-feed — Get the activity feed for a board
 *
 * Returns recent board events from the `board_events` collection, sorted
 * newest-first. This replaces the old pattern of iterating all tasks and
 * merging their embedded `activity` arrays.
 *
 * Params:
 *   boardId  — Board to fetch events for (required)
 *   limit    — Max events to return (default 50, max 200)
 *   cursor   — Pagination cursor (timestamp of last event from previous page)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { BoardService } from '../../../services/board-service'
import type { BoardEventService } from '../../../services/board-event-service'
import type { WorkspaceService } from '../../../services/workspace-service'

interface GetBoardFeedData {
  boardId: string
  limit?: number
  cursor?: string
}

export function createGetBoardFeedHandler(
  boardService: BoardService,
  workspaceService: WorkspaceService,
  boardEventService: BoardEventService,
) {
  return async function getBoardFeed(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetBoardFeedData
    const { boardId, limit, cursor } = data

    if (!boardId) throw new HandlerError('MISSING_FIELDS', 'boardId is required')

    const board = await boardService.getBoard(boardId)
    if (!board) throw new HandlerError('NOT_FOUND', 'Board not found')

    const project = await boardService.getProject(board.projectId)
    if (!project) throw new HandlerError('NOT_FOUND', 'Project not found')

    const role = await workspaceService.getUserRole(project.workspaceId, ctx.userId)
    if (role === null) throw new HandlerError('FORBIDDEN', 'No access to this board')

    const result = await boardEventService.getBoardFeed(boardId, {
      limit: limit ?? 50,
      cursor,
      sort: 'desc',
    })

    return {
      boardId,
      events: result.events,
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    }
  }
}
