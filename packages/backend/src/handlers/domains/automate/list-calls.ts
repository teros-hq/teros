/**
 * automate.list-calls — list recent webhook calls for a starter.
 */

import type { WsHandler } from '@teros/shared'
import type { AutomateModel } from '../../../models/automate'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'

export function createListCallsHandler(
  model: AutomateModel,
  workspaceService: WorkspaceService,
): WsHandler {
  return async (ctx, data) => {
    const userId = ctx.userId
    const starterId = (data as any)?.starterId

    if (!starterId || typeof starterId !== 'string') {
      throw new HandlerError('MISSING_FIELDS', 'starterId is required')
    }

    const starter = await model.getStarterById(starterId)
    if (!starter) {
      throw new HandlerError('NOT_FOUND', 'Starter not found')
    }

    const hasAccess = await workspaceService.canAccess(starter.workspaceId, userId)
    if (!hasAccess) {
      throw new HandlerError('FORBIDDEN', 'Access denied to workspace')
    }

    const calls = await model.listWebhookCalls(starterId)
    return { calls }
  }
}
