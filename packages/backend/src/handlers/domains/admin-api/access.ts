/**
 * admin-api.access — Control de acceso agente↔app (admin)
 *
 * Actions:
 *   admin-api.access-list    → GET  /admin/access
 *   admin-api.access-grant   → POST /admin/access
 *   admin-api.access-revoke  → DELETE /admin/access/:agentId/:appId
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { McaService } from '../../../services/mca-service'

async function requireAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection('users').findOne({ userId })
  if (user?.role !== 'admin' && user?.role !== 'super') {
    throw new HandlerError('FORBIDDEN', 'Admin privileges required')
  }
}

export function createAccessListHandler(db: Db, mcaService: McaService) {
  const accessCollection = db.collection('agent_app_access')
  const agentsCollection = db.collection('agents')

  return async function accessList(ctx: WsHandlerContext, _rawData: unknown) {
    await requireAdmin(db, ctx.userId)

    const accessDocs = await accessCollection.find({}).toArray()

    const enriched = await Promise.all(
      accessDocs.map(async (a: any) => {
        const app = await mcaService.getApp(a.appId)
        const agent = await agentsCollection.findOne({ agentId: a.agentId })
        return {
          agentId: a.agentId,
          agentName: (agent as any)?.name ?? 'Unknown',
          appId: a.appId,
          appName: app?.name ?? 'Unknown',
          grantedBy: a.grantedBy,
          grantedAt: a.grantedAt,
          permissions: a.permissions,
        }
      }),
    )

    return { access: enriched }
  }
}

export function createAccessGrantHandler(db: Db, mcaService: McaService) {
  return async function accessGrant(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as { agentId: string; appId: string }

    if (!data.agentId || !data.appId) {
      throw new HandlerError('VALIDATION_ERROR', 'Missing required fields: agentId, appId')
    }

    const access = await mcaService.grantAccess({
      agentId: data.agentId,
      appId: data.appId,
      grantedBy: 'admin',
    })

    return { access }
  }
}

export function createAccessRevokeHandler(db: Db, mcaService: McaService) {
  return async function accessRevoke(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as { agentId: string; appId: string }

    if (!data.agentId || !data.appId) {
      throw new HandlerError('VALIDATION_ERROR', 'Missing required fields: agentId, appId')
    }

    const success = await mcaService.revokeAccess(data.agentId, data.appId)
    if (!success) throw new HandlerError('NOT_FOUND', 'Access grant not found')

    return { success: true, agentId: data.agentId, appId: data.appId }
  }
}
