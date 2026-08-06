/**
 * file-share domain — registers file share/unshare handlers with the router
 *
 * Actions:
 *   file.share     → Create a public share link for a file
 *   file.unshare   → Revoke an existing share link
 *   file.get-share → Get existing share for a file (if any)
 *
 * Both handlers require an authenticated session (ctx.userId).
 *
 * file.share resolves the workspaceId from the channelId (channels collection)
 * and delegates to ShareService.createShare.
 *
 * file.unshare delegates to ShareService.deleteShare, which verifies ownership
 * before deleting.
 *
 * file.get-share looks up an existing share for (filePath, workspaceId, ownerId)
 * and returns it if found, or null otherwise.
 */

import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { Db } from 'mongodb'
import type { ShareService } from '../../../services/share-service'
import type { WsHandlerContext } from '@teros/shared'
import { HandlerError } from '../../../ws-framework/WsRouter'
import { canAccessWorkspace } from '../../../auth/workspace-access'
import { config } from '../../../config'

// ============================================================================
// TYPES
// ============================================================================

interface FileShareData {
  filePath: string
  channelId: string
  fileType: 'html' | 'markdown'
}

interface FileUnshareData {
  shareId: string
}

interface FileGetShareData {
  filePath: string
  channelId: string
}

// ============================================================================
// DOMAIN DEPS
// ============================================================================

export interface FileShareDomainDeps {
  db: Db
  shareService: ShareService
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

/**
 * Resolve the workspaceId from a channelId and assert the caller may act on it.
 * Workspace is sovereign: only members may share/inspect files from its volume.
 * Shared by file.share and file.get-share (identical channel→workspace+authz).
 */
async function resolveAuthorizedWorkspace(
  db: Db,
  userId: string,
  channelId: string,
): Promise<string> {
  const channel = await db.collection<any>('channels').findOne({ channelId })
  if (!channel) {
    throw new HandlerError('CHANNEL_NOT_FOUND', `Channel not found: ${channelId}`)
  }
  if (!channel.workspaceId) {
    throw new HandlerError('NO_WORKSPACE', `Channel ${channelId} has no associated workspace`)
  }
  if (!(await canAccessWorkspace(db, userId, channel.workspaceId))) {
    throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${channel.workspaceId}`)
  }
  return channel.workspaceId
}

// ============================================================================
// HANDLER FACTORIES
// ============================================================================

function createFileShareHandler(deps: FileShareDomainDeps) {
  const { db, shareService } = deps

  return async function fileShare(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as FileShareData
    const { filePath, channelId, fileType } = data

    if (!filePath) throw new HandlerError('MISSING_FIELDS', 'filePath is required')
    if (!channelId) throw new HandlerError('MISSING_FIELDS', 'channelId is required')
    if (!fileType) throw new HandlerError('MISSING_FIELDS', 'fileType is required')
    if (fileType !== 'html' && fileType !== 'markdown') {
      throw new HandlerError('INVALID_FILE_TYPE', 'fileType must be "html" or "markdown"')
    }

    const workspaceId = await resolveAuthorizedWorkspace(db, ctx.userId, channelId)

    let result: Awaited<ReturnType<typeof shareService.createShare>>
    try {
      result = await shareService.createShare(ctx.userId, filePath, workspaceId, fileType)
    } catch (err: any) {
      console.error(`[FileShare] Failed to create share for ${filePath}:`, err.message)
      throw new HandlerError('SHARE_CREATE_ERROR', `Failed to create share: ${err.message}`)
    }

    console.log(`[FileShare] Created share ${result.shareId} for user ${ctx.userId} → ${filePath}`)

    return { shareId: result.shareId, publicUrl: result.publicUrl }
  }
}

function createFileUnshareHandler(deps: FileShareDomainDeps) {
  const { shareService } = deps

  return async function fileUnshare(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as FileUnshareData
    const { shareId } = data

    if (!shareId) throw new HandlerError('MISSING_FIELDS', 'shareId is required')

    try {
      await shareService.deleteShare(shareId, ctx.userId)
    } catch (err: any) {
      console.error(`[FileShare] Failed to delete share ${shareId}:`, err.message)
      // Distinguish between not-found and permission-denied
      if (err.message?.includes('not found')) {
        throw new HandlerError('SHARE_NOT_FOUND', `Share not found: ${shareId}`)
      }
      if (err.message?.includes('Permission denied')) {
        throw new HandlerError('SHARE_PERMISSION_DENIED', err.message)
      }
      throw new HandlerError('SHARE_DELETE_ERROR', `Failed to delete share: ${err.message}`)
    }

    console.log(`[FileShare] Deleted share ${shareId} by user ${ctx.userId}`)

    return { ok: true as const }
  }
}

function createFileGetShareHandler(deps: FileShareDomainDeps) {
  const { db, shareService } = deps

  return async function fileGetShare(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as FileGetShareData
    const { filePath, channelId } = data

    if (!filePath) throw new HandlerError('MISSING_FIELDS', 'filePath is required')
    if (!channelId) throw new HandlerError('MISSING_FIELDS', 'channelId is required')

    const workspaceId = await resolveAuthorizedWorkspace(db, ctx.userId, channelId)

    // Look up existing share for this file + workspace + owner
    const share = await shareService.getShareByFile(ctx.userId, filePath, workspaceId)

    if (!share) {
      return { share: null }
    }

    const publicUrl = `${config.share.baseUrl}/share/${share.shareId}`

    return { share: { shareId: share.shareId, publicUrl } }
  }
}

// ============================================================================
// REGISTER
// ============================================================================

export function register(router: WsRouter, deps: FileShareDomainDeps): void {
  router.register('file.share', createFileShareHandler(deps))
  router.register('file.unshare', createFileUnshareHandler(deps))
  router.register('file.get-share', createFileGetShareHandler(deps))
}
