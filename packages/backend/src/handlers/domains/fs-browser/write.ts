/**
 * fs.write — Write content to a file within a workspace volume
 *
 * Request:  { filePath: string, content: string, workspaceId?: string, channelId?: string }
 * Response: { filePath: string, bytesWritten: number }
 * Error:    { error: string }
 *
 * Security:
 *  - Resolves the workspace volume host path from workspaceId or channelId
 *  - Validates the path is within the volume (anti path-traversal)
 *  - Only allows writing inside the authenticated workspace volume
 *  - The caller needs the write role on the workspace that owns the volume
 */

import { writeFile } from 'fs/promises'
import { join, resolve, normalize } from 'path'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { VolumeService } from '../../../services/volume-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import { resolveVolumeHostPath } from '../../../lib/volume-path-resolver'
import { canUseVolumeContext } from '../../../auth/workspace-access'

// ============================================================================
// TYPES
// ============================================================================

interface FsWriteData {
  filePath: string
  content: string
  workspaceId?: string
  channelId?: string
}

export interface FsWriteResult {
  filePath: string
  bytesWritten: number
}

// ============================================================================
// HANDLER FACTORY
// ============================================================================

export interface FsWriteDeps {
  db: Db
  volumeService: VolumeService
  workspaceService: WorkspaceService
}

export function createFsWriteHandler(deps: FsWriteDeps) {
  const { db, volumeService, workspaceService } = deps

  return async function fsWriteHandler(ctx: WsHandlerContext, rawData: unknown): Promise<FsWriteResult> {
    const data = rawData as FsWriteData
    const { filePath, content, workspaceId, channelId } = data

    if (!filePath) throw new HandlerError('MISSING_FIELDS', 'filePath is required')
    if (content === undefined || content === null) throw new HandlerError('MISSING_FIELDS', 'content is required')
    if (!workspaceId && !channelId) throw new HandlerError('MISSING_FIELDS', 'workspaceId or channelId is required')

    // Use whichever context identifier was provided
    const contextId = (workspaceId ?? channelId)!

    // Authorize the same context the resolver uses, before touching it
    if (!(await canUseVolumeContext(db, ctx.userId, contextId, 'write'))) {
      throw new HandlerError('FORBIDDEN', 'Write access to the workspace is required')
    }

    // Resolve the host path using the shared helper from file-watcher
    let hostPath: string
    try {
      hostPath = await resolveVolumeHostPath(filePath, contextId, db, volumeService, workspaceService)
    } catch (err: any) {
      console.error(`[FsWrite] Failed to resolve path for ${filePath}:`, err.message)
      throw new HandlerError('FS_WRITE_ERROR', `Cannot resolve file path: ${err.message}`)
    }

    // Additional path-traversal guard: ensure resolved host path doesn't escape
    // the volume root (resolveHostPath already checks this, but double-check)
    if (hostPath.includes('..')) {
      throw new HandlerError('FS_WRITE_ERROR', 'Access denied: invalid file path')
    }

    // Write the file
    try {
      await writeFile(hostPath, content, 'utf-8')
    } catch (err: any) {
      console.error(`[FsWrite] Failed to write ${hostPath}:`, err.message)
      if (/EACCES|EPERM/i.test(err.message)) {
        throw new HandlerError('FS_WRITE_ERROR', `Permission denied: cannot write to ${filePath}`)
      }
      if (/ENOENT/i.test(err.message)) {
        throw new HandlerError('FS_WRITE_ERROR', `Directory not found for path: ${filePath}`)
      }
      throw new HandlerError('FS_WRITE_ERROR', `Write failed: ${err.message}`)
    }

    const bytesWritten = Buffer.byteLength(content, 'utf-8')
    console.log(`[FsWrite] Wrote ${bytesWritten} bytes to ${filePath} (host: ${hostPath})`)

    return { filePath, bytesWritten }
  }
}
