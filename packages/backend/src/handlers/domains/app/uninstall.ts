/**
 * app.uninstall — Uninstall an installed app
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'

interface UninstallAppData {
  appId: string
}

export function createUninstallAppHandler(mcaService: McaService) {
  return async function uninstallApp(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UninstallAppData
    const { appId } = data

    if (!appId) {
      throw new HandlerError('MISSING_APP_ID', 'appId is required')
    }

    const result = await mcaService.deleteApp(appId, ctx.userId)

    if (!result.success) {
      throw new HandlerError('UNINSTALL_APP_ERROR', result.error || 'Failed to uninstall app')
    }

    console.log(`✅ Uninstalled app ${appId} for user ${ctx.userId}`)

    return { appId }
  }
}
