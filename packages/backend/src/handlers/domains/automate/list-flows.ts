/**
 * automate.list-flows — list workspace flows for the start-flow action picker.
 *
 * Lightweight projection (flowId, name, status) so the frontend can offer a
 * flow selector without going through the workflows MCA.
 */

import type { WsHandler } from '@teros/shared'
import type { Db } from 'mongodb'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'

export function createListFlowsHandler(
  db: Db,
  workspaceService: WorkspaceService,
): WsHandler {
  return async (ctx, data) => {
    const userId = ctx.userId
    const workspaceId = (data as any)?.workspaceId

    if (!workspaceId || typeof workspaceId !== 'string') {
      throw new HandlerError('MISSING_FIELDS', 'workspaceId is required')
    }

    const hasAccess = await workspaceService.canAccess(workspaceId, userId)
    if (!hasAccess) {
      throw new HandlerError('FORBIDDEN', 'Access denied to workspace')
    }

    const flows = await db
      .collection('flows')
      .find(
        { workspaceId },
        { projection: { _id: 0, flowId: 1, name: 1, status: 1 } },
      )
      .sort({ name: 1 })
      .toArray()

    return { flows }
  }
}
