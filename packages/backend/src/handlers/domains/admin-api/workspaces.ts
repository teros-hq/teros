/**
 * admin-api.workspaces — CRUD de workspaces (admin)
 *
 * Actions:
 *   admin-api.workspaces-list              → GET  /admin/workspaces
 *   admin-api.workspaces-get               → GET  /admin/workspaces/:workspaceId
 *   admin-api.workspaces-create            → POST /admin/workspaces
 *   admin-api.workspaces-update            → PATCH /admin/workspaces/:workspaceId
 *   admin-api.workspaces-archive           → POST /admin/workspaces/:workspaceId/archive
 *   admin-api.workspaces-members-add       → POST /admin/workspaces/:workspaceId/members
 *   admin-api.workspaces-members-remove    → DELETE /admin/workspaces/:workspaceId/members/:userId
 *   admin-api.workspaces-members-update    → PATCH /admin/workspaces/:workspaceId/members/:userId
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { WorkspaceService } from '../../../services/workspace-service'

async function requireAdmin(db: Db, userId: string): Promise<void> {
  const user = await db.collection('users').findOne({ userId })
  if (user?.role !== 'admin' && user?.role !== 'super') {
    throw new HandlerError('FORBIDDEN', 'Admin privileges required')
  }
}

function requireWorkspaceService(ws: WorkspaceService | undefined): WorkspaceService {
  if (!ws) throw new HandlerError('SERVICE_UNAVAILABLE', 'Workspace service not available')
  return ws
}

export function createWorkspacesListHandler(db: Db) {
  return async function workspacesList(ctx: WsHandlerContext, _rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const workspaces = await db.collection('workspaces').find({ status: 'active' }).toArray()
    return { workspaces }
  }
}

export function createWorkspacesGetHandler(db: Db, workspaceService?: WorkspaceService) {
  return async function workspacesGet(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const ws = requireWorkspaceService(workspaceService)
    const data = rawData as { workspaceId: string }
    if (!data.workspaceId) throw new HandlerError('VALIDATION_ERROR', 'workspaceId is required')

    const workspace = await ws.getWorkspace(data.workspaceId)
    if (!workspace) throw new HandlerError('NOT_FOUND', 'Workspace not found')
    return { workspace }
  }
}

export function createWorkspacesCreateHandler(db: Db, workspaceService?: WorkspaceService) {
  return async function workspacesCreate(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const ws = requireWorkspaceService(workspaceService)
    const data = rawData as { name: string; description?: string; ownerId?: string }

    if (!data.name) throw new HandlerError('VALIDATION_ERROR', 'Missing required field: name')

    const workspace = await ws.createWorkspace(data.ownerId || 'system', {
      name: data.name,
      description: data.description,
    })
    return { workspace }
  }
}

export function createWorkspacesUpdateHandler(db: Db, workspaceService?: WorkspaceService) {
  return async function workspacesUpdate(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const ws = requireWorkspaceService(workspaceService)
    const data = rawData as { workspaceId: string; name?: string; description?: string }
    if (!data.workspaceId) throw new HandlerError('VALIDATION_ERROR', 'workspaceId is required')

    const workspace = await ws.updateWorkspace(data.workspaceId, 'system', {
      name: data.name,
      description: data.description,
    })
    if (!workspace) throw new HandlerError('NOT_FOUND', 'Workspace not found')
    return { workspace }
  }
}

export function createWorkspacesArchiveHandler(db: Db, workspaceService?: WorkspaceService) {
  return async function workspacesArchive(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const ws = requireWorkspaceService(workspaceService)
    const data = rawData as { workspaceId: string }
    if (!data.workspaceId) throw new HandlerError('VALIDATION_ERROR', 'workspaceId is required')

    const workspace = await ws.getWorkspace(data.workspaceId)
    if (!workspace) throw new HandlerError('NOT_FOUND', 'Workspace not found')

    const success = await ws.archiveWorkspace(data.workspaceId, (workspace as any).ownerId)
    if (!success) throw new HandlerError('INTERNAL_ERROR', 'Failed to archive workspace')
    return { success: true, workspaceId: data.workspaceId }
  }
}

export function createWorkspacesMembersAddHandler(db: Db, workspaceService?: WorkspaceService) {
  return async function workspacesMembersAdd(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const ws = requireWorkspaceService(workspaceService)
    const data = rawData as { workspaceId: string; userId: string; role: string }
    if (!data.workspaceId || !data.userId || !data.role) {
      throw new HandlerError('VALIDATION_ERROR', 'Missing required fields: workspaceId, userId, role')
    }

    const validRoles = ['admin', 'write', 'read'] as const
    type WorkspaceRole = typeof validRoles[number]
    if (!validRoles.includes(data.role as WorkspaceRole)) {
      throw new HandlerError('VALIDATION_ERROR', 'role must be one of: admin, write, read')
    }

    const success = await ws.addMember(data.workspaceId, data.userId, data.role as WorkspaceRole, 'system')
    return { success, workspaceId: data.workspaceId, userId: data.userId, role: data.role }
  }
}

export function createWorkspacesMembersRemoveHandler(db: Db, workspaceService?: WorkspaceService) {
  return async function workspacesMembersRemove(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const ws = requireWorkspaceService(workspaceService)
    const data = rawData as { workspaceId: string; userId: string }
    if (!data.workspaceId || !data.userId) {
      throw new HandlerError('VALIDATION_ERROR', 'Missing required fields: workspaceId, userId')
    }

    const success = await ws.removeMember(data.workspaceId, data.userId, 'system')
    return { success, workspaceId: data.workspaceId, userId: data.userId }
  }
}

export function createWorkspacesMembersUpdateHandler(db: Db, workspaceService?: WorkspaceService) {
  return async function workspacesMembersUpdate(ctx: WsHandlerContext, rawData: unknown) {
    await requireAdmin(db, ctx.userId)
    const ws = requireWorkspaceService(workspaceService)
    const data = rawData as { workspaceId: string; userId: string; role: string }
    if (!data.workspaceId || !data.userId || !data.role) {
      throw new HandlerError('VALIDATION_ERROR', 'Missing required fields: workspaceId, userId, role')
    }

    const validRoles = ['admin', 'write', 'read'] as const
    type WorkspaceRole = typeof validRoles[number]
    if (!validRoles.includes(data.role as WorkspaceRole)) {
      throw new HandlerError('VALIDATION_ERROR', 'role must be one of: admin, write, read')
    }

    const success = await ws.updateMemberRole(data.workspaceId, data.userId, data.role as WorkspaceRole, 'system')
    return { success, workspaceId: data.workspaceId, userId: data.userId, role: data.role }
  }
}
