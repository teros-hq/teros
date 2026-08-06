/**
 * app.revoke-access — Revoke an agent's access to an app
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { McaService } from '../../../services/mca-service'

interface RevokeAccessData {
  agentId: string
  appId: string
}

export function createRevokeAccessHandler(mcaService: McaService) {
  return async function revokeAccess(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as RevokeAccessData
    const { agentId, appId } = data

    if (!agentId) {
      throw new HandlerError('MISSING_AGENT_ID', 'agentId is required')
    }
    if (!appId) {
      throw new HandlerError('MISSING_APP_ID', 'appId is required')
    }

    // SEC-1 (TER-720 / A1): the caller must own the agent AND be able to access
    // the app's workspace — otherwise any user could revoke another tenant's
    // agent grants (cross-tenant DoS).
    const allowed = await mcaService.canManageAppAccess(ctx.userId, agentId, appId)
    if (!allowed) {
      throw new HandlerError('ACCESS_DENIED', `You cannot manage access for app ${appId}`)
    }

    const success = await mcaService.revokeAccess(agentId, appId)

    console.log(`✅ Revoked ${agentId} access to ${appId}`)

    return { agentId, appId, success }
  }
}
