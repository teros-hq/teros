/**
 * automate.sync-flow-triggers — a flow's triggers as Automate starters.
 *
 * A flow with a schedule / webhook / event trigger is, for Automate, one
 * starter per trigger whose action is `start-flow` and whose `ownerFlowId` is
 * the flow. The workflows MCA calls this after every save or delete and the
 * handler reconciles: creates what is missing, updates what changed, keeps
 * webhook tokens stable, deletes what the flow no longer declares, and
 * disables everything while the flow is not active.
 *
 * Request:
 *   { workspaceId, flowId, projectId, name, active, triggers: [
 *       { type: 'schedule', cronExpression, timezone? } |
 *       { type: 'webhook' } |
 *       { type: 'event', topic, rules? } ] }
 *   or { workspaceId, flowId, remove: true } to delete every owned starter.
 *
 * Response: { starters, webhookUrl? } — webhookUrl once, when a webhook token
 * was minted in this call.
 */

import type { Db } from 'mongodb'
import type { WsHandler } from '@teros/shared'
import type { AutomateModel } from '../../../models/automate'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { AutomateStarter, AutomateTrigger } from '../../../types/database-automate'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { requireWriteRole } from './_helpers'
import { validateActionInput, validateTriggerInput } from './_validation'
import { newWebhookToken } from './_webhook-token'

type FlowTriggerInput =
  | { type: 'schedule'; cronExpression: string; timezone?: string }
  | { type: 'webhook' }
  | { type: 'event'; topic: string; rules?: Array<Record<string, unknown>> }

function toAutomateTrigger(t: FlowTriggerInput): AutomateTrigger {
  if (t.type === 'schedule') {
    return validateTriggerInput({ type: 'scheduler', cronExpression: t.cronExpression, timezone: t.timezone })
  }
  if (t.type === 'webhook') return validateTriggerInput({ type: 'webhook' })
  return validateTriggerInput({ type: 'event', eventPattern: t.topic, filters: t.rules })
}

/** One starter per trigger kind per flow: the key the reconcile matches on. */
function triggerKey(t: { type: string }): string {
  return t.type === 'schedule' ? 'scheduler' : t.type
}

export function createSyncFlowTriggersHandler(
  model: AutomateModel,
  workspaceService: WorkspaceService,
  db: Db,
): WsHandler {
  return async (ctx, data) => {
    const d = data as Record<string, unknown>
    const workspaceId = d.workspaceId
    const flowId = d.flowId
    if (typeof workspaceId !== 'string' || !workspaceId) throw new HandlerError('MISSING_FIELDS', 'workspaceId is required')
    if (typeof flowId !== 'string' || !flowId) throw new HandlerError('MISSING_FIELDS', 'flowId is required')

    const role = await workspaceService.getUserRole(workspaceId, ctx.userId)
    requireWriteRole(role)

    const owned = await model.listStarters(workspaceId, { ownerFlowId: flowId })

    if (d.remove === true) {
      const deleted = await model.deleteStartersByOwnerFlow(workspaceId, flowId)
      return { starters: [], deleted }
    }

    const projectId = d.projectId
    if (typeof projectId !== 'string' || !projectId) throw new HandlerError('MISSING_FIELDS', 'projectId is required')
    const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : flowId
    const active = d.active !== false
    const triggers = Array.isArray(d.triggers) ? (d.triggers as FlowTriggerInput[]) : []

    const action = await validateActionInput({ type: 'start-flow', flowId, projectId }, { db, workspaceId })

    const wanted = new Map<string, FlowTriggerInput>()
    for (const t of triggers) {
      if (!t || typeof t !== 'object' || !['schedule', 'webhook', 'event'].includes((t as { type?: string }).type ?? '')) {
        throw new HandlerError('VALIDATION_ERROR', 'triggers[].type must be schedule, webhook or event')
      }
      wanted.set(triggerKey(t), t)
    }

    const result: AutomateStarter[] = []
    let webhookUrl: string | undefined

    // Delete owned starters whose trigger kind the flow no longer declares.
    for (const starter of owned) {
      if (!wanted.has(starter.type)) await model.deleteStarter(starter.starterId)
    }

    for (const [key, t] of wanted) {
      const existing = owned.find((s) => s.type === key)
      const trigger = toAutomateTrigger(t)
      const starterName = `${name} · ${key === 'scheduler' ? 'schedule' : key}`

      if (existing) {
        // Keep the webhook token and the scheduler's runtime state.
        if (trigger.type === 'webhook' && existing.trigger.type === 'webhook') {
          trigger.tokenHash = existing.trigger.tokenHash
          trigger.callCount = existing.trigger.callCount ?? 0
        } else if (trigger.type === 'scheduler' && existing.trigger.type === 'scheduler') {
          const same =
            existing.trigger.cronExpression === trigger.cronExpression &&
            (existing.trigger.timezone ?? 'UTC') === (trigger.timezone ?? 'UTC')
          trigger.totalExecutions = existing.trigger.totalExecutions ?? 0
          if (same && existing.trigger.nextRunAt) trigger.nextRunAt = existing.trigger.nextRunAt
        }
        const updated = await model.updateStarter(existing.starterId, {
          name: starterName,
          enabled: active,
          trigger,
          action,
        })
        if (updated) result.push(updated)
        continue
      }

      if (trigger.type === 'webhook') {
        const token = newWebhookToken()
        trigger.tokenHash = token.hash
        webhookUrl = token.url
      }
      const created = await model.createStarter({
        name: starterName,
        workspaceId,
        createdBy: ctx.userId,
        createdByAgentId: ctx.actor?.kind === 'agent' ? ctx.actor.agentId : undefined,
        trigger,
        action,
        enabled: active,
        ownerFlowId: flowId,
      })
      result.push(created)
    }

    return { starters: result, webhookUrl }
  }
}
