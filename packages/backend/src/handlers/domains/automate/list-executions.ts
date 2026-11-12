/**
 * automate.list-executions — execution history of one starter, newest first.
 *
 * Request: { starterId, limit? (≤200, default 50), cursor? (opaque: the
 * previous page's nextCursor, `createdAt|executionId` of its last row) }.
 * Response carries `nextCursor` while a full page came back.
 */

import type { WsHandler } from '@teros/shared'
import type { AutomateModel } from '../../../models/automate'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'

export function createListExecutionsHandler(
  model: AutomateModel,
  workspaceService: WorkspaceService,
): WsHandler {
  return async (ctx, data) => {
    const d = data as { starterId?: unknown; limit?: unknown; cursor?: unknown }
    if (!d?.starterId || typeof d.starterId !== 'string') {
      throw new HandlerError('MISSING_FIELDS', 'starterId is required')
    }

    const starter = await model.getStarterById(d.starterId)
    if (!starter) {
      throw new HandlerError('NOT_FOUND', 'Starter not found')
    }
    const hasAccess = await workspaceService.canAccess(starter.workspaceId, ctx.userId)
    if (!hasAccess) {
      throw new HandlerError('FORBIDDEN', 'Access denied to workspace')
    }

    const limit = typeof d.limit === 'number' && d.limit > 0 ? Math.min(d.limit, 200) : 50
    const executions = await model.listExecutions(starter.starterId, {
      limit,
      cursor: typeof d.cursor === 'string' ? d.cursor : undefined,
    })
    const last = executions[executions.length - 1]
    const nextCursor = executions.length === limit ? `${last.createdAt}|${last.executionId}` : undefined
    return { executions, nextCursor }
  }
}
