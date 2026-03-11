/**
 * app.disconnect-auth — Revoke OAuth credentials for an app
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { AppAuthInfo } from '@teros/core'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'
import type { McaOAuth } from '../../../auth/mca-oauth'

interface DisconnectAuthData {
  appId: string
}

export function createDisconnectAuthHandler(
  mcaService: McaService,
  mcaOAuth: McaOAuth | null | undefined,
) {
  return async function disconnectAuth(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as DisconnectAuthData
    const { appId } = data

    if (!appId) {
      throw new HandlerError('MISSING_APP_ID', 'appId is required')
    }
    if (!mcaOAuth) {
      throw new HandlerError('AUTH_NOT_CONFIGURED', 'MCA OAuth not configured')
    }

    await mcaOAuth.disconnect(ctx.userId, appId)

    const app = await mcaService.getApp(appId)
    let auth: AppAuthInfo = { status: 'needs_user_auth', authType: 'none' }

    if (app) {
      const mca = await mcaService.getMcaFromCatalog(app.mcaId)
      if (mca) {
        auth = await mcaOAuth.getAuthStatus(ctx.userId, appId, mca)
      }
    }

    console.log(`✅ Disconnected auth for app ${appId} user ${ctx.userId}`)

    return { appId, success: true, auth }
  }
}
