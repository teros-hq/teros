/**
 * automate.test-webhook — fire a webhook starter's action from the UI.
 *
 * Same code path as the public HTTP ingestion route (ingestWebhookPayload),
 * but authenticated and without the enabled check — a disabled starter can
 * still be tested from its detail screen.
 */

import type { WsHandler } from '@teros/shared'
import type { AutomateModel } from '../../../models/automate'
import type { AutomateRunner } from '../../../services/automate-runner'
import { ingestWebhookPayload } from '../../../services/automate-webhook-ingest'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { loadStarterForWrite } from './_helpers'

export function createTestWebhookHandler(
  model: AutomateModel,
  workspaceService: WorkspaceService,
  runner: AutomateRunner | null,
): WsHandler {
  return async (ctx, data) => {
    const payload = (data as any)?.payload
    if (payload === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new HandlerError('MISSING_FIELDS', 'payload object is required')
    }

    const starter = await loadStarterForWrite(model, workspaceService, ctx, data)
    if (starter.type !== 'webhook') {
      throw new HandlerError('INVALID_TYPE', 'Only webhook starters can be tested')
    }
    if (!runner) {
      throw new HandlerError('INTERNAL_ERROR', 'AutomateRunner not available')
    }

    const result = await ingestWebhookPayload(model, runner, starter, payload as Record<string, unknown>, {
      ip: ctx.ip,
      noteLabel: 'test payload',
    })
    if (!result.ok) {
      throw new HandlerError('EXECUTION_ERROR', result.error ?? 'Action execution failed')
    }

    return {
      taskId: result.taskId,
      executionId: result.executionId,
      outcome: result.updatedExisting ? ('updated' as const) : ('created' as const),
    }
  }
}
