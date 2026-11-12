/**
 * share domain — public share links for workspace files over the WsRouter.
 *
 * Actions:
 *   share.create — Create (or return the existing) public share link for a file
 *   share.get    — Look up the existing share for a file → { shared, shareId?, url? }
 *   share.revoke — Revoke a share by shareId
 *
 * This is the WebSocket replacement for the REST /api/share endpoints. It
 * reuses ShareService (single source of truth for `shared_files`) and the
 * same channel→workspace authorization the old REST path enforced.
 *
 * Identity: the handler runs as ctx.userId — the turn's user, resolved
 * server-side. When the caller is an agent tool (MCA bridge), ctx.actor.kind
 * is 'agent' and ctx.actor.agentId identifies the agent; we log it for audit
 * and annotate the share document with createdByAgentId (schema-additive, no
 * migration — Mongo accepts the extra field).
 */

import type { Db } from 'mongodb'
import type { WsHandlerContext, WsHandler } from '@teros/shared'
import type { ShareService } from '../../../services/share-service'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { canAccessWorkspace } from '../../../auth/workspace-access'
import { config } from '../../../config'

// ============================================================================
// TYPES
// ============================================================================

interface ShareCreateData {
  filePath: string
  channelId: string
  fileType: 'html' | 'markdown' | 'file'
}

interface ShareGetData {
  filePath: string
  channelId?: string
  workspaceId?: string
}

interface ShareRevokeData {
  shareId?: string
  filePath?: string
  channelId?: string
  workspaceId?: string
}

// ============================================================================
// DOMAIN DEPS
// ============================================================================

export interface ShareDomainDeps {
  db: Db
  shareService: ShareService
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

function requireString(data: Record<string, unknown>, field: string): string {
  const value = data[field]
  if (!value || typeof value !== 'string') {
    throw new HandlerError('MISSING_FIELDS', `${field} is required`)
  }
  return value
}

/**
 * Resolve the workspaceId for a share lookup/create from channelId when given,
 * falling back to an explicit workspaceId (File Browser context has no channel).
 * Mirrors the validation the old REST path enforced (TER-551): the workspace is
 * sovereign — only members may share/inspect files from its volume.
 */
async function resolveAuthorizedWorkspace(
  db: Db,
  userId: string,
  data: { channelId?: string; workspaceId?: string },
): Promise<string> {
  if (data.channelId) {
    const channel = await db.collection<any>('channels').findOne({ channelId: data.channelId })
    if (!channel) {
      throw new HandlerError('CHANNEL_NOT_FOUND', `Channel not found: ${data.channelId}`)
    }
    if (!channel.workspaceId) {
      throw new HandlerError('NO_WORKSPACE', `Channel ${data.channelId} has no associated workspace`)
    }
    if (!(await canAccessWorkspace(db, userId, channel.workspaceId))) {
      throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${channel.workspaceId}`)
    }
    return channel.workspaceId as string
  }

  if (data.workspaceId) {
    if (!(await canAccessWorkspace(db, userId, data.workspaceId))) {
      throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${data.workspaceId}`)
    }
    return data.workspaceId
  }

  throw new HandlerError('MISSING_FIELDS', 'channelId or workspaceId is required')
}

/** Audit line: who (user or agent) did what, on which workspace. */
function auditLine(ctx: WsHandlerContext): string {
  const actor = ctx.actor
  if (actor?.kind === 'agent' && actor.agentId) {
    return `agent ${actor.agentId} (user ${ctx.userId})`
  }
  return `user ${ctx.userId}`
}

// ============================================================================
// HANDLERS
// ============================================================================

function createShareCreateHandler(deps: ShareDomainDeps): WsHandler {
  const { db, shareService } = deps

  return async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as ShareCreateData
    const filePath = requireString(data as any, 'filePath')
    const channelId = requireString(data as any, 'channelId')
    const fileType = data.fileType

    if (fileType !== 'html' && fileType !== 'markdown' && fileType !== 'file') {
      throw new HandlerError('INVALID_FILE_TYPE', 'fileType must be "html", "markdown" or "file"')
    }

    const workspaceId = await resolveAuthorizedWorkspace(db, ctx.userId, { channelId })

    let result: Awaited<ReturnType<typeof shareService.createShare>>
    try {
      result = await shareService.createShare(ctx.userId, filePath, workspaceId, fileType)
    } catch (err: any) {
      console.error(`[Share] Failed to create share for ${filePath}:`, err.message)
      throw new HandlerError('SHARE_CREATE_ERROR', `Failed to create share: ${err.message}`)
    }

    // Audit + agent annotation (schema-additive: extra field on the share doc,
    // no migration — matches the spec's "anotar agentId si el schema lo permite").
    if (ctx.actor?.kind === 'agent' && ctx.actor.agentId) {
      try {
        await db
          .collection('shared_files')
          .updateOne({ shareId: result.shareId }, { $set: { createdByAgentId: ctx.actor.agentId } })
      } catch (err: any) {
        // Annotation is best-effort audit metadata — never fail the share.
        console.warn(`[Share] Could not annotate agent on share ${result.shareId}:`, err.message)
      }
    }
    console.log(
      `[Share] Created share ${result.shareId} by ${auditLine(ctx)} → ${filePath} (workspace ${workspaceId})`,
    )

    return { shareId: result.shareId, url: result.publicUrl }
  }
}

function createShareGetHandler(deps: ShareDomainDeps): WsHandler {
  const { db, shareService } = deps

  return async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as ShareGetData
    const filePath = requireString(data as any, 'filePath')
    const workspaceId = await resolveAuthorizedWorkspace(db, ctx.userId, data)

    const share = await shareService.getShareByFile(ctx.userId, filePath, workspaceId)
    if (!share) {
      return { shared: false }
    }

    console.log(`[Share] Looked up share ${share.shareId} by ${auditLine(ctx)} → ${filePath}`)

    return {
      shared: true,
      shareId: share.shareId,
      url: `${config.share.baseUrl}/share/${share.shareId}`,
    }
  }
}

function createShareRevokeHandler(deps: ShareDomainDeps): WsHandler {
  const { db, shareService } = deps

  return async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = (rawData ?? {}) as ShareRevokeData

    // Accept either shareId directly, or filePath (+ channel/workspace context)
    // so callers can revoke without remembering the shareId.
    let shareId = typeof data.shareId === 'string' && data.shareId ? data.shareId : undefined

    if (!shareId) {
      const filePath = requireString(data as any, 'filePath')
      const workspaceId = await resolveAuthorizedWorkspace(db, ctx.userId, data)
      const share = await shareService.getShareByFile(ctx.userId, filePath, workspaceId)
      if (!share) {
        throw new HandlerError('SHARE_NOT_FOUND', `No share found for ${filePath}`)
      }
      shareId = share.shareId
    }

    try {
      await shareService.deleteShare(shareId, ctx.userId)
    } catch (err: any) {
      console.error(`[Share] Failed to delete share ${shareId}:`, err.message)
      if (err.message?.includes('not found')) {
        throw new HandlerError('SHARE_NOT_FOUND', `Share not found: ${shareId}`)
      }
      if (err.message?.includes('Permission denied')) {
        throw new HandlerError('SHARE_PERMISSION_DENIED', err.message)
      }
      throw new HandlerError('SHARE_DELETE_ERROR', `Failed to delete share: ${err.message}`)
    }

    console.log(`[Share] Revoked share ${shareId} by ${auditLine(ctx)}`)

    return { ok: true as const, shareId }
  }
}

// ============================================================================
// REGISTER
// ============================================================================

export function register(router: { register: (action: string, handler: WsHandler) => void }, deps: ShareDomainDeps): void {
  router.register('share.create', createShareCreateHandler(deps))
  router.register('share.get', createShareGetHandler(deps))
  router.register('share.revoke', createShareRevokeHandler(deps))
}
