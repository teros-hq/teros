/**
 * automate.get — one starter with resolved display names and 7-day stats.
 */

import type { WsHandler } from '@teros/shared'
import type { AutomateModel } from '../../../models/automate'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'

const STATS_WINDOW_DAYS = 7

export function createGetHandler(model: AutomateModel, workspaceService: WorkspaceService): WsHandler {
  return async (ctx, data) => {
    const starterId = (data as { starterId?: unknown })?.starterId
    if (!starterId || typeof starterId !== 'string') {
      throw new HandlerError('MISSING_FIELDS', 'starterId is required')
    }

    const starter = await model.getStarterWithNames(starterId)
    if (!starter) {
      throw new HandlerError('NOT_FOUND', 'Starter not found')
    }

    const hasAccess = await workspaceService.canAccess(starter.workspaceId, ctx.userId)
    if (!hasAccess) {
      throw new HandlerError('FORBIDDEN', 'Access denied to workspace')
    }

    const stats = await model.countExecutionsPerStarter([starter.starterId], STATS_WINDOW_DAYS)
    const entry = stats.get(starter.starterId)
    const trigger = starter.trigger as { lastCallAt?: string; lastExecutionAt?: string }
    return {
      starter: {
        ...starter,
        avgDailyRuns7d: entry ? Math.round((entry.count / STATS_WINDOW_DAYS) * 10) / 10 : 0,
        lastExecutionAt: entry?.lastExecutionAt ?? trigger.lastCallAt ?? trigger.lastExecutionAt,
      },
    }
  }
}
