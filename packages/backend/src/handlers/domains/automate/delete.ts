/**
 * automate.delete — delete a starter (any trigger/action type).
 */

import type { WsHandler } from '@teros/shared'
import type { AutomateModel } from '../../../models/automate'
import type { WorkspaceService } from '../../../services/workspace-service'
import { loadStarterForWrite } from './_helpers'

export function createDeleteHandler(
  model: AutomateModel,
  workspaceService: WorkspaceService,
): WsHandler {
  return async (ctx, data) => {
    const starter = await loadStarterForWrite(model, workspaceService, ctx, data)
    await model.deleteStarter(starter.starterId)
    return { deleted: true }
  }
}
