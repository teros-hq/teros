/**
 * automate.parse-schedule — translate a natural-language schedule (or a raw
 * cron) into its canonical cron + human description + next occurrences.
 *
 * Powers the Automate window's always-on preview (v1.4.4): as the user types
 * "cada lunes a las 9", the form shows "Se ejecutará: lunes a las 09:00" and
 * the next three dates, computed in the schedule's timezone. Read-only —
 * nothing is created.
 */

import type { WsHandler } from '@teros/shared'
import { describeScheduleCron, parseScheduleExpression } from '@teros/shared'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { assertValidCron, assertValidTimezone, previewCronOccurrences } from '../../../lib/cron'

export function createParseScheduleHandler(workspaceService: WorkspaceService): WsHandler {
  return async (ctx, data) => {
    const userId = ctx.userId
    const { workspaceId, expression, timezone, locale } = (data ?? {}) as {
      workspaceId?: string
      expression?: string
      timezone?: string
      locale?: string
    }

    if (!workspaceId || typeof workspaceId !== 'string') {
      throw new HandlerError('MISSING_FIELDS', 'workspaceId is required')
    }
    if (!expression || typeof expression !== 'string') {
      throw new HandlerError('MISSING_FIELDS', 'expression is required')
    }
    const hasAccess = await workspaceService.canAccess(workspaceId, userId)
    if (!hasAccess) throw new HandlerError('FORBIDDEN', 'Access denied to workspace')

    const tz = timezone && timezone.trim() ? timezone.trim() : 'UTC'
    try {
      assertValidTimezone(tz)
    } catch (error) {
      throw new HandlerError('INVALID_TIMEZONE', error instanceof Error ? error.message : 'Invalid timezone')
    }

    const parsed = parseScheduleExpression(expression)
    if (!parsed.ok) {
      // Not an error the user must fix in a dialog — the form shows the
      // suggestion inline while typing. ok:false travels, HTTP stays 200.
      return { ok: false, error: parsed.error, suggestion: parsed.suggestion }
    }

    try {
      assertValidCron(parsed.cron)
    } catch (error) {
      throw new HandlerError('INVALID_CRON', error instanceof Error ? error.message : 'Invalid cron expression')
    }

    const next = previewCronOccurrences(parsed.cron, tz, 3)
    const es = locale === 'es'
    return {
      ok: true,
      cron: parsed.cron,
      detectedText: parsed.detectedText,
      scheduleHuman: describeScheduleCron(parsed.cron, es ? 'es' : 'en'),
      timezone: tz,
      next: next.map((ms) => new Date(ms).toISOString()),
    }
  }
}
