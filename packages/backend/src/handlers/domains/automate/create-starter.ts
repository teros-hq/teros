/**
 * automate.create-starter — create a starter of any trigger/action combo.
 *
 * Body: { workspaceId, name, trigger, action, enabled?, idempotencyKey? }
 *   trigger: { type: 'scheduler', cronExpression, timezone? } |
 *            { type: 'once', at, timezone? } |
 *            { type: 'webhook' } |
 *            { type: 'event', eventPattern, filters? }
 *   action:  { type: 'create-task', projectId, agentId, targetColumnId?, ... } |
 *            { type: 'channel-event', channelId, agentId, eventTemplate? } |
 *            { type: 'start-flow', flowId, projectId, inputMapping? }
 *
 * Returns { starter, url?, existing? } — url only for webhook triggers (shown
 * once); existing=true when idempotencyKey matched a starter already created.
 */

import type { Db } from 'mongodb'
import type { WsHandler } from '@teros/shared'
import type { AutomateModel } from '../../../models/automate'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { requireFields, requireWriteRole } from './_helpers'
import { validateActionInput, validateTriggerInput } from './_validation'
import { newWebhookToken } from './_webhook-token'

export function createCreateStarterHandler(
  model: AutomateModel,
  workspaceService: WorkspaceService,
  db: Db,
): WsHandler {
  return async (ctx, data) => {
    const userId = ctx.userId
    const workspaceId = (data as any)?.workspaceId

    requireFields(data as any, ['name'])

    if (!workspaceId || typeof workspaceId !== 'string') {
      throw new HandlerError('MISSING_FIELDS', 'workspaceId is required')
    }

    const name = ((data as any).name as string).trim()
    if (!name) {
      throw new HandlerError('VALIDATION_ERROR', 'name must be a non-empty string')
    }

    const enabled = (data as any)?.enabled
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new HandlerError('VALIDATION_ERROR', 'enabled must be a boolean')
    }

    const role = await workspaceService.getUserRole(workspaceId, userId)
    requireWriteRole(role)

    const hasAccess = await workspaceService.canAccess(workspaceId, userId)
    if (!hasAccess) {
      throw new HandlerError('FORBIDDEN', 'Access denied to workspace')
    }

    const idempotencyKey = (data as any)?.idempotencyKey
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 128)) {
      throw new HandlerError('VALIDATION_ERROR', 'idempotencyKey must be a string of at most 128 characters')
    }
    if (idempotencyKey) {
      const existing = await model.getStarterByIdempotencyKey(workspaceId, idempotencyKey)
      if (existing) return { starter: existing, url: undefined, existing: true }
    }

    const trigger = validateTriggerInput((data as any).trigger)
    const action = await validateActionInput((data as any).action, { db, workspaceId })

    let url: string | undefined
    if (trigger.type === 'webhook') {
      const token = newWebhookToken()
      trigger.tokenHash = token.hash
      url = token.url
    }

    const starter = await model.createStarter({
      name,
      workspaceId,
      createdBy: userId,
      createdByAgentId: ctx.actor?.kind === 'agent' ? ctx.actor.agentId : undefined,
      trigger,
      action,
      enabled,
      idempotencyKey: idempotencyKey || undefined,
    })

    return { starter, url }
  }
}
