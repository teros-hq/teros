/**
 * automate.regenerate-url — rotate a webhook starter's secret token.
 *
 * Returns the new full URL once. The token hash stored in the starter is
 * replaced, so the old URL stops working immediately.
 */

import type { WsHandler } from '@teros/shared'
import type { AutomateModel } from '../../../models/automate'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { loadStarterForWrite } from './_helpers'
import { newWebhookToken } from './_webhook-token'

export function createRegenerateUrlHandler(
  model: AutomateModel,
  workspaceService: WorkspaceService,
): WsHandler {
  return async (ctx, data) => {
    const starter = await loadStarterForWrite(model, workspaceService, ctx, data)

    if (starter.type !== 'webhook') {
      throw new HandlerError('INVALID_TYPE', 'Only webhook starters can regenerate a URL')
    }

    const token = newWebhookToken()
    const updated = await model.regenerateWebhookToken(starter.starterId, token.hash)
    if (!updated) {
      throw new HandlerError('INTERNAL_ERROR', 'Failed to regenerate webhook token')
    }

    return { url: token.url }
  }
}
