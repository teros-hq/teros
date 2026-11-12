/**
 * automate.set-enabled — toggle a starter's enabled flag.
 */

import type { WsHandler } from '@teros/shared'
import type { AutomateModel } from '../../../models/automate'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { loadStarterForWrite } from './_helpers'

export function createSetEnabledHandler(
  model: AutomateModel,
  workspaceService: WorkspaceService,
): WsHandler {
  return async (ctx, data) => {
    const enabled = (data as any)?.enabled
    if (typeof enabled !== 'boolean') {
      throw new HandlerError('MISSING_FIELDS', 'enabled boolean is required')
    }

    const starter = await loadStarterForWrite(model, workspaceService, ctx, data)
    const updated = await model.setStarterEnabled(starter.starterId, enabled)
    return { starter: updated }
  }
}
