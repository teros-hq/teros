/**
 * automate.list — list starters in a workspace (v2 trigger/action shape).
 *
 * Optional filters: trigger, action, status (active|disabled), search (name),
 * limit (≤200) + cursor (createdAt of the last item) for paging; the
 * response carries `nextCursor` while there may be more.
 *
 * Each starter is enriched with grid stats (2026-10 redesign):
 *   avgDailyRuns7d  — executions / 7 over the trailing 7-day window (rounded to 1 decimal)
 *   lastExecutionAt — most recent execution across ALL trigger kinds (falls back
 *                     to the per-trigger lastCallAt/lastExecutionAt stored on
 *                     the starter when the audit log has no rows yet)
 */

import type { WsHandler } from '@teros/shared'
import type { AutomateModel } from '../../../models/automate'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'

const STATS_WINDOW_DAYS = 7

function isOneOf(v: unknown, values: string[]): boolean {
  return typeof v === 'string' && values.includes(v)
}

export function createListHandler(
  model: AutomateModel,
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

    const d = data as Record<string, unknown>
    const limit = typeof d.limit === 'number' && d.limit > 0 ? Math.min(d.limit, 200) : undefined
    const starters = await model.listStartersWithNames(workspaceId, {
      type: isOneOf(d.trigger, ['scheduler', 'once', 'webhook', 'event']) ? (d.trigger as any) : undefined,
      actionType: isOneOf(d.action, ['create-task', 'channel-event', 'start-flow']) ? (d.action as any) : undefined,
      enabled: d.status === 'active' ? true : d.status === 'disabled' ? false : undefined,
      search: typeof d.search === 'string' ? d.search : undefined,
      limit,
      cursor: typeof d.cursor === 'string' ? d.cursor : undefined,
    })
    const nextCursor = limit && starters.length === limit ? starters[starters.length - 1].createdAt : undefined

    // Grid stats: one aggregate over the execution audit log for the whole
    // workspace (7-day window), then merged per starter.
    const stats = await model.countExecutionsPerStarter(
      starters.map((s) => s.starterId),
      STATS_WINDOW_DAYS,
    )

    const enriched = starters.map((starter) => {
      const entry = stats.get(starter.starterId)
      const avgDailyRuns7d = entry
        ? Math.round((entry.count / STATS_WINDOW_DAYS) * 10) / 10
        : 0

      // Prefer the audit log's last execution; fall back to the per-trigger
      // counters the legacy paths still maintain (webhook lastCallAt,
      // scheduler lastExecutionAt).
      const trigger = starter.trigger as { lastCallAt?: string; lastExecutionAt?: string }
      const lastExecutionAt = entry?.lastExecutionAt ?? trigger.lastCallAt ?? trigger.lastExecutionAt

      return { ...starter, avgDailyRuns7d, lastExecutionAt }
    })

    return { starters: enriched, nextCursor }
  }
}
