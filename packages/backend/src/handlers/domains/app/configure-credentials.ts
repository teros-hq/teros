/**
 * app.configure-credentials — Save API-key credentials for an app
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'
import type { McaOAuth } from '../../../auth/mca-oauth'

interface ConfigureCredentialsData {
  appId: string
  credentials: Record<string, string>
}

export function createConfigureCredentialsHandler(
  mcaService: McaService,
  mcaOAuth: McaOAuth | null | undefined,
) {
  return async function configureCredentials(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as ConfigureCredentialsData
    const { appId, credentials } = data

    if (!appId) {
      throw new HandlerError('MISSING_APP_ID', 'appId is required')
    }
    if (!credentials || Object.keys(credentials).length === 0) {
      throw new HandlerError('MISSING_CREDENTIALS', 'credentials are required')
    }
    if (!mcaOAuth) {
      throw new HandlerError('AUTH_NOT_CONFIGURED', 'MCA OAuth not configured')
    }

    const app = await mcaService.getApp(appId)
    if (!app) {
      throw new HandlerError('APP_NOT_FOUND', `App ${appId} not found`)
    }

    await mcaOAuth.saveApiKeyCredentials(ctx.userId, appId, app.mcaId, credentials)

    const mca = await mcaService.getMcaFromCatalog(app.mcaId)
    const auth = mca
      ? await mcaOAuth.getAuthStatus(ctx.userId, appId, mca)
      : { status: 'ready' as const, authType: 'apikey' as const }

    console.log(`✅ Configured credentials for app ${appId} user ${ctx.userId}`)

    return { appId, success: true, auth }
  }
}
