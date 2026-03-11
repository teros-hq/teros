/**
 * admin-api.apps — CRUD de apps instaladas (admin)
 *
 * Actions:
 *   admin-api.apps-list              → GET  /admin/apps
 *   admin-api.apps-get               → GET  /admin/apps/:appId
 *   admin-api.apps-create            → POST /admin/apps
 *   admin-api.apps-update            → PATCH /admin/apps/:appId
 *   admin-api.apps-delete            → DELETE /admin/apps/:appId
 *   admin-api.apps-get-access        → GET  /admin/apps/:appId/access
 *   admin-api.apps-update-permission → PATCH /admin/apps/:appId/permissions
 *   admin-api.apps-set-permissions   → PUT  /admin/apps/:appId/permissions
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import { generateAppId } from '@teros/core'
import type { McaService } from '../../../services/mca-service'

async function requireAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection('users').findOne({ userId })
  if (user?.role !== 'admin' && user?.role !== 'super') {
    throw new HandlerError('FORBIDDEN', 'Admin privileges required')
  }
}

export function createAppsListHandler(db: Db, mcaService: McaService) {
  const appsCollection = db.collection('apps')

  return async function appsList(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = (rawData ?? {}) as { ownerId?: string; ownerType?: string }

    const filter: Record<string, unknown> = {}
    if (data.ownerId) filter.ownerId = data.ownerId
    if (data.ownerType) filter.ownerType = data.ownerType

    const apps = await appsCollection.find(filter).toArray()

    const enrichedApps = await Promise.all(
      apps.map(async (app: any) => {
        const catalog = await mcaService.getMcaFromCatalog(app.mcaId)
        return {
          appId: app.appId,
          name: app.name,
          mcaId: app.mcaId,
          mcaName: catalog?.name ?? 'Unknown',
          ownerId: app.ownerId,
          ownerType: app.ownerType || 'user',
          status: app.status,
          permissions: app.permissions,
          createdAt: app.createdAt,
        }
      }),
    )

    return { apps: enrichedApps }
  }
}

export function createAppsGetHandler(db: Db, mcaService: McaService) {
  return async function appsGet(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as { appId: string }
    if (!data.appId) throw new HandlerError('VALIDATION_ERROR', 'appId is required')

    const app = await mcaService.getApp(data.appId)
    if (!app) throw new HandlerError('NOT_FOUND', 'App not found')

    const catalog = await mcaService.getMcaFromCatalog(app.mcaId)
    return { ...app, mcaName: catalog?.name ?? 'Unknown', tools: catalog?.tools ?? [] }
  }
}

export function createAppsCreateHandler(db: Db, mcaService: McaService) {
  return async function appsCreate(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as { mcaId: string; name?: string; workspaceId?: string; ownerId?: string }

    if (!data.mcaId) throw new HandlerError('VALIDATION_ERROR', 'Missing required field: mcaId')

    const effectiveOwnerId = data.workspaceId || data.ownerId || 'system'
    const ownerType = data.workspaceId ? 'workspace' : 'user'
    const appName = data.name || (await mcaService.generateDefaultAppName(data.mcaId, effectiveOwnerId))

    const validation = mcaService.validateAppName(appName)
    if (!validation.valid) throw new HandlerError('VALIDATION_ERROR', validation.error!)

    const newApp = await mcaService.createApp({
      appId: generateAppId(),
      mcaId: data.mcaId,
      ownerId: effectiveOwnerId,
      ownerType,
      name: appName,
      status: 'active',
    })

    return { app: newApp }
  }
}

export function createAppsUpdateHandler(db: Db, mcaService: McaService) {
  const appsCollection = db.collection('apps')

  return async function appsUpdate(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as { appId: string; name: string }
    if (!data.appId) throw new HandlerError('VALIDATION_ERROR', 'appId is required')
    if (!data.name) throw new HandlerError('VALIDATION_ERROR', 'Missing required field: name')

    const validation = mcaService.validateAppName(data.name)
    if (!validation.valid) throw new HandlerError('VALIDATION_ERROR', validation.error!)

    const result = await appsCollection.findOneAndUpdate(
      { appId: data.appId },
      { $set: { name: data.name, updatedAt: new Date().toISOString() } },
      { returnDocument: 'after' },
    )

    if (!result) throw new HandlerError('NOT_FOUND', 'App not found')
    return { app: result }
  }
}

export function createAppsDeleteHandler(db: Db) {
  const appsCollection = db.collection('apps')
  const accessCollection = db.collection('agent_app_access')

  return async function appsDelete(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as { appId: string }
    if (!data.appId) throw new HandlerError('VALIDATION_ERROR', 'appId is required')

    await accessCollection.deleteMany({ appId: data.appId })
    const result = await appsCollection.deleteOne({ appId: data.appId })

    if (result.deletedCount === 0) throw new HandlerError('NOT_FOUND', 'App not found')
    return { success: true, appId: data.appId }
  }
}

export function createAppsGetAccessHandler(db: Db) {
  const accessCollection = db.collection('agent_app_access')
  const agentsCollection = db.collection('agents')

  return async function appsGetAccess(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as { appId: string }
    if (!data.appId) throw new HandlerError('VALIDATION_ERROR', 'appId is required')

    const accessList = await accessCollection.find({ appId: data.appId }).toArray()

    const agents = await Promise.all(
      accessList.map(async (a: any) => {
        const agent = await agentsCollection.findOne({ agentId: a.agentId })
        return {
          agentId: a.agentId,
          agentName: (agent as any)?.name ?? 'Unknown',
          agentFullName: (agent as any)?.fullName ?? 'Unknown',
          grantedAt: a.grantedAt,
          grantedBy: a.grantedBy,
          permissions: a.permissions,
        }
      }),
    )

    return { appId: data.appId, agents }
  }
}

export function createAppsUpdatePermissionHandler(db: Db, mcaService: McaService) {
  return async function appsUpdatePermission(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as { appId: string; toolName: string; permission: string }
    if (!data.appId || !data.toolName || !data.permission) {
      throw new HandlerError('VALIDATION_ERROR', 'Missing required fields: appId, toolName, permission')
    }
    if (!['allow', 'ask', 'forbid'].includes(data.permission)) {
      throw new HandlerError('VALIDATION_ERROR', 'Permission must be one of: allow, ask, forbid')
    }

    const app = await mcaService.updateToolPermission(data.appId, data.toolName, data.permission as any)
    if (!app) throw new HandlerError('NOT_FOUND', 'App not found')
    return { app }
  }
}

export function createAppsSetPermissionsHandler(db: Db, mcaService: McaService) {
  return async function appsSetPermissions(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const data = rawData as { appId: string; permission: string }
    if (!data.appId || !data.permission) {
      throw new HandlerError('VALIDATION_ERROR', 'Missing required fields: appId, permission')
    }
    if (!['allow', 'ask', 'forbid'].includes(data.permission)) {
      throw new HandlerError('VALIDATION_ERROR', 'Permission must be one of: allow, ask, forbid')
    }

    const app = await mcaService.setAllToolPermissions(data.appId, data.permission as any)
    if (!app) throw new HandlerError('NOT_FOUND', 'App not found')
    return { app }
  }
}
