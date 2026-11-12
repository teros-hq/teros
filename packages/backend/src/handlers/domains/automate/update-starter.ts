/**
 * automate.update-starter — patch name / enabled / trigger / action.
 *
 * Trigger and action are validated and replaced whole, but the runtime state
 * a trigger accumulates is carried over when its kind does not change:
 *   - scheduler: totalExecutions, lastExecutionAt, schedulerTaskId,
 *                lastExecutionChannelId. nextRunAt is recomputed only when the
 *                cron or the timezone changed.
 *   - once:      totalExecutions, lastExecutionAt; a new `at` re-arms it.
 *   - webhook:   tokenHash, callCount, lastCallAt (the URL keeps working).
 * Switching a starter TO a webhook trigger mints a new token and returns its
 * URL once, exactly like create-starter.
 */

import type { Db } from 'mongodb'
import type { WsHandler } from '@teros/shared'
import type { AutomateModel } from '../../../models/automate'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { AutomateTrigger, SchedulerTrigger, WebhookTrigger } from '../../../types/database-automate'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { loadStarterForWrite } from './_helpers'
import { validateActionInput, validateTriggerInput } from './_validation'
import { newWebhookToken } from './_webhook-token'

export function createUpdateStarterHandler(
  model: AutomateModel,
  workspaceService: WorkspaceService,
  db: Db,
): WsHandler {
  return async (ctx, data) => {
    const starter = await loadStarterForWrite(model, workspaceService, ctx, data)

    const patch: {
      name?: string
      enabled?: boolean
      trigger?: AutomateTrigger
      action?: Awaited<ReturnType<typeof validateActionInput>>
    } = {}

    const name = (data as any)?.name
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        throw new HandlerError('VALIDATION_ERROR', 'name must be a non-empty string')
      }
      patch.name = name.trim()
    }

    const enabled = (data as any)?.enabled
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        throw new HandlerError('VALIDATION_ERROR', 'enabled must be a boolean')
      }
      patch.enabled = enabled
    }

    let url: string | undefined
    if ((data as any)?.trigger !== undefined) {
      const next = validateTriggerInput((data as any).trigger)
      const current = starter.trigger

      if (next.type === 'scheduler' && current.type === 'scheduler') {
        const sameSchedule =
          current.cronExpression === next.cronExpression &&
          (current.timezone ?? 'UTC') === (next.timezone ?? 'UTC')
        const carried: SchedulerTrigger = {
          ...next,
          totalExecutions: current.totalExecutions ?? 0,
          ...(current.lastExecutionAt ? { lastExecutionAt: current.lastExecutionAt } : {}),
          ...(current.schedulerTaskId ? { schedulerTaskId: current.schedulerTaskId } : {}),
          ...(current.lastExecutionChannelId
            ? { lastExecutionChannelId: current.lastExecutionChannelId }
            : {}),
        }
        if (sameSchedule && current.nextRunAt) carried.nextRunAt = current.nextRunAt
        patch.trigger = carried
      } else if (next.type === 'once' && current.type === 'once') {
        // A re-timed reminder keeps its history and arms again.
        patch.trigger = {
          ...next,
          totalExecutions: current.totalExecutions ?? 0,
          ...(current.lastExecutionAt ? { lastExecutionAt: current.lastExecutionAt } : {}),
          ...(current.reminderId ? { reminderId: current.reminderId } : {}),
        }
      } else if (next.type === 'webhook' && current.type === 'webhook') {
        const carried: WebhookTrigger = {
          type: 'webhook',
          tokenHash: current.tokenHash,
          callCount: current.callCount ?? 0,
          ...(current.lastCallAt ? { lastCallAt: current.lastCallAt } : {}),
        }
        patch.trigger = carried
      } else if (next.type === 'webhook') {
        const token = newWebhookToken()
        next.tokenHash = token.hash
        url = token.url
        patch.trigger = next
      } else {
        patch.trigger = next
      }
    }

    if ((data as any)?.action !== undefined) {
      patch.action = await validateActionInput((data as any).action, {
        db,
        workspaceId: starter.workspaceId,
      })
    }

    const updated = await model.updateStarter(starter.starterId, patch)
    if (!updated) {
      throw new HandlerError('INTERNAL_ERROR', 'Failed to update starter')
    }

    return { starter: updated, url }
  }
}
