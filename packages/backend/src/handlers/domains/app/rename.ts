/**
 * app.rename — Rename an installed app (optionally update context)
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'

interface RenameAppData {
  appId: string
  name: string
  context?: string
}

export function createRenameAppHandler(mcaService: McaService) {
  return async function renameApp(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as RenameAppData
    const { appId, name, context } = data

    if (!appId) {
      throw new HandlerError('MISSING_APP_ID', 'appId is required')
    }
    if (!name) {
      throw new HandlerError('MISSING_NAME', 'name is required')
    }

    const result = await mcaService.renameApp(appId, ctx.userId, name)
    if (!result.success) {
      throw new HandlerError('RENAME_APP_ERROR', result.error || 'Failed to rename app')
    }

    if (context !== undefined) {
      const contextResult = await mcaService.updateAppContext(appId, ctx.userId, context)
      if (!contextResult.success) {
        throw new HandlerError(
          'UPDATE_APP_CONTEXT_ERROR',
          contextResult.error || 'Failed to update app context',
        )
      }
    }

    console.log(`✅ Renamed app ${appId} to "${name}" for user ${ctx.userId}`)

    return {
      appId,
      name,
      ...(context !== undefined ? { context } : {}),
    }
  }
}
