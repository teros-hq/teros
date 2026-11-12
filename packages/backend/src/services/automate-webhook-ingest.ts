/**
 * Webhook ingestion — the one code path that turns a webhook payload into an
 * execution. Shared by the public HTTP route (POST /api/v1/webhooks/:token)
 * and the authenticated `automate.test-webhook` handler so both behave
 * identically:
 *
 *   1. create-task actions dedupe on `discriminator` (falls back to `id`):
 *      a repeated value appends the payload as a progress note on the task
 *      the first call created instead of creating a new one.
 *   2. Otherwise the starter's action runs through AutomateRunner.
 *   3. The call is written to `automate_webhook_calls`, the per-trigger
 *      counters are bumped and — on the dedupe path, where the runner is not
 *      involved — an `automate_executions` row is recorded so the grid stats
 *      count every call.
 */

import type { AutomateModel } from '../models/automate'
import type { AutomateStarter } from '../types/database-automate'
import type { AutomateRunner } from './automate-runner'

export interface WebhookIngestOptions {
  /** Source IP for the audit row (HTTP route only). */
  ip?: string
  /** Label used in the appended progress note ("payload" / "test payload"). */
  noteLabel?: string
}

export interface WebhookIngestResult {
  ok: boolean
  actionType: AutomateStarter['action']['type']
  /** Task that was created (create-task) or updated (dedupe path). */
  taskId?: string
  /** Flow execution id (start-flow). */
  executionId?: string
  /** True when an existing task was updated instead of a new one created. */
  updatedExisting: boolean
  error?: string
  /** True when a guard (billing / daily quota) refused the run — nothing executed. */
  refused?: boolean
}

export function extractDiscriminator(payload: Record<string, unknown>): string | undefined {
  const raw = payload.discriminator ?? payload.id
  return typeof raw === 'string' && raw ? raw : undefined
}

export async function ingestWebhookPayload(
  model: AutomateModel,
  runner: AutomateRunner,
  starter: AutomateStarter,
  payload: Record<string, unknown>,
  opts: WebhookIngestOptions = {},
): Promise<WebhookIngestResult> {
  const now = new Date().toISOString()
  const discriminator = extractDiscriminator(payload)

  let existingTaskId: string | undefined
  if (starter.action.type === 'create-task' && discriminator) {
    existingTaskId = await model.getExistingTaskForDiscriminator(starter.starterId, discriminator)
  }

  let result: WebhookIngestResult
  let updatedExisting = false
  if (existingTaskId) {
    const label = opts.noteLabel ?? 'payload'
    const noteText = `Webhook ${label} received at ${now}\n\n${JSON.stringify(payload, null, 2)}`
    const agentId = (starter.action as { agentId?: string }).agentId ?? 'system'
    updatedExisting = await runner.appendPayloadNote(existingTaskId, noteText, agentId)
  }

  if (updatedExisting) {
    result = { ok: true, actionType: 'create-task', taskId: existingTaskId, updatedExisting: true }
    // The runner records executions itself; the dedupe path bypasses it.
    await model.recordExecution({
      starterId: starter.starterId,
      workspaceId: starter.workspaceId,
      source: 'webhook',
      ok: true,
      taskId: existingTaskId,
    })
  } else {
    const run = await runner.executeAction(starter, { source: 'webhook', payload })
    result = {
      ok: run.ok,
      actionType: run.actionType,
      taskId: run.taskId,
      executionId: run.executionId,
      updatedExisting: false,
      error: run.error,
      refused: run.refused,
    }
  }

  await model.recordWebhookCall({
    starterId: starter.starterId,
    payload,
    discriminator,
    taskId: result.taskId,
    createdTask: result.ok && !!result.taskId && !updatedExisting,
    ip: opts.ip,
  })
  await model.updateWebhookStats(starter.starterId, now)

  return result
}
