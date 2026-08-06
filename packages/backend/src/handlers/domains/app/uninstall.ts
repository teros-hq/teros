/**
 * app.uninstall — Uninstall an installed app
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'
import type { PubSubService } from '../../../services/pubsub-service'

interface UninstallAppData {
  appId: string
}

export function createUninstallAppHandler(
  mcaService: McaService,
  pubSubService?: PubSubService | null,
) {
  return async function uninstallApp(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UninstallAppData
    const { appId } = data

    if (!appId) {
      throw new HandlerError('MISSING_APP_ID', 'appId is required')
    }

    // Capture ownerId BEFORE delete so we can fan-out the event to the workspace.
    const existingApp = await mcaService.getApp(appId)
    const ownerId = existingApp?.ownerId ?? null

    const result = await mcaService.deleteApp(appId, ctx.userId)

    if (!result.success) {
      throw new HandlerError('UNINSTALL_APP_ERROR', result.error || 'Failed to uninstall app')
    }

    console.log(`✅ Uninstalled app ${appId} for user ${ctx.userId}`)

    if (pubSubService && ownerId) {
      await pubSubService.broadcastToWorkspace(ownerId, {
        type: 'app.uninstalled',
        appId,
        ownerId,
      })
    }

    return { appId }
  }
}
