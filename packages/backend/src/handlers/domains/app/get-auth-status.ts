/**
 * app.get-auth-status — Get OAuth/API-key auth status for an app
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'
import type { McaOAuth } from '../../../auth/mca-oauth'

interface GetAuthStatusData {
  appId: string
}

export function createGetAuthStatusHandler(mcaService: McaService, mcaOAuth: McaOAuth | null | undefined) {
  return async function getAuthStatus(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GetAuthStatusData
    const { appId } = data

    if (!appId) {
      throw new HandlerError('MISSING_APP_ID', 'appId is required')
    }
    if (!mcaOAuth) {
      throw new HandlerError('AUTH_NOT_CONFIGURED', 'MCA OAuth not configured')
    }

    const app = await mcaService.getApp(appId)
    if (!app) {
      throw new HandlerError('APP_NOT_FOUND', `App ${appId} not found`)
    }

    const mca = await mcaService.getMcaFromCatalog(app.mcaId)
    if (!mca) {
      throw new HandlerError('MCA_NOT_FOUND', `MCA ${app.mcaId} not found`)
    }

    const auth = await mcaOAuth.getAuthStatus(ctx.userId, appId, mca)

    console.log(`[app.get-auth-status] Auth status for ${appId}: ${auth.status}`)

    return { appId, auth }
  }
}
