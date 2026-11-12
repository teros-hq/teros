/**
 * Shared helpers for Automate WebSocket handlers.
 */

import type { WsHandlerContext } from '@teros/shared'
import type { AutomateModel, AutomateStarter } from '../../../models/automate'
import type { WorkspaceService } from '../../../services/workspace-service'
import { HandlerError } from '../../../ws-framework/WsRouter'

export function requireFields(data: Record<string, unknown>, fields: string[]): void {
  const missing = fields.filter((f) => !data[f] || typeof data[f] !== 'string')
  if (missing.length > 0) {
    throw new HandlerError('MISSING_FIELDS', `Missing required fields: ${missing.join(', ')}`)
  }
}

export function requireWriteRole(role: string | null): void {
  if (!role || (role !== 'owner' && role !== 'admin' && role !== 'write')) {
    throw new HandlerError('FORBIDDEN', 'Write access required')
  }
}

/**
 * Resolve a starter by id for a mutating handler: it must exist, belong to the
 * workspace the client says it belongs to (when the client sends one), and the
 * caller must have write access to that workspace.
 */
export async function loadStarterForWrite(
  model: AutomateModel,
  workspaceService: WorkspaceService,
  ctx: WsHandlerContext,
  data: unknown,
): Promise<AutomateStarter> {
  const starterId = (data as { starterId?: unknown })?.starterId
  const workspaceId = (data as { workspaceId?: unknown })?.workspaceId

  if (!starterId || typeof starterId !== 'string') {
    throw new HandlerError('MISSING_FIELDS', 'starterId is required')
  }

  const starter = await model.getStarterById(starterId)
  if (!starter) {
    throw new HandlerError('NOT_FOUND', 'Starter not found')
  }
  if (typeof workspaceId === 'string' && workspaceId && starter.workspaceId !== workspaceId) {
    throw new HandlerError('FORBIDDEN', 'Starter does not belong to this workspace')
  }

  const role = await workspaceService.getUserRole(starter.workspaceId, ctx.userId)
  requireWriteRole(role)

  const hasAccess = await workspaceService.canAccess(starter.workspaceId, ctx.userId)
  if (!hasAccess) {
    throw new HandlerError('FORBIDDEN', 'Access denied to workspace')
  }

  return starter
}
