/**
 * app.grant-access — Grant an agent access to an app
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'

interface GrantAccessData {
  agentId: string
  appId: string
}

export function createGrantAccessHandler(mcaService: McaService) {
  return async function grantAccess(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as GrantAccessData
    const { agentId, appId } = data

    if (!agentId) {
      throw new HandlerError('MISSING_AGENT_ID', 'agentId is required')
    }
    if (!appId) {
      throw new HandlerError('MISSING_APP_ID', 'appId is required')
    }

    // SEC-1 (TER-720 / A1): the caller must own the agent AND be able to access
    // the app's workspace. Without this, any user could grant their agent access
    // to another tenant's installed app (BOLA + a route to admin-MCA tools).
    const allowed = await mcaService.canManageAppAccess(ctx.userId, agentId, appId)
    if (!allowed) {
      throw new HandlerError('ACCESS_DENIED', `You cannot manage access for app ${appId}`)
    }

    await mcaService.grantAccess({
      agentId,
      appId,
      grantedBy: ctx.userId,
    })

    console.log(`✅ Granted ${agentId} access to ${appId}`)

    return { agentId, appId, success: true }
  }
}
