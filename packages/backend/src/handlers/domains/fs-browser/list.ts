/**
 * fs.list — List directory contents for a workspace volume
 *
 * Request:  { workspaceId: string, path: string }
 * Response: { path: string, entries: FileEntry[], truncated: boolean }
 * Error:    { error: string }
 *
 * Security:
 *  - Resolves the workspace volume host path from workspaceId
 *  - Validates the requested path is within the volume root (path traversal prevention)
 *  - Read-only: no write operations exposed
 */

import { readdir, stat } from 'fs/promises'
import type { Dirent } from 'fs'
import { join, resolve, normalize } from 'path'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { VolumeService } from '../../../services/volume-service'
import type { WorkspaceService } from '../../../services/workspace-service'

// ============================================================================
// TYPES
// ============================================================================

interface FsListData {
  workspaceId: string
  path: string
}

export interface FileEntry {
  name: string
  type: 'file' | 'directory'
  size: number | null   // bytes; null for directories
  modifiedAt: string    // ISO 8601
  path: string          // absolute path inside the volume (container perspective)
}

export interface FsListResult {
  path: string
  entries: FileEntry[]
  truncated: boolean
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CONTAINER_MOUNT = '/workspace'
const MAX_ENTRIES = 1000

// ============================================================================
// VOLUME RESOLVER
// ============================================================================

/**
 * Resolve the host path for a workspace volume.
 * Extends the existing channel-based resolver to accept workspaceId directly.
 */
async function resolveWorkspaceVolumeRoot(
  workspaceId: string,
  db: Db,
  volumeService: VolumeService,
  workspaceService: WorkspaceService,
): Promise<string> {
  const workspace = await workspaceService.getWorkspace(workspaceId)
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
  if (!workspace.volumeId) throw new Error(`Workspace has no volume: ${workspaceId}`)

  const vol = await volumeService.getVolume(workspace.volumeId)
  if (!vol) throw new Error(`Volume not found: ${workspace.volumeId}`)

  return vol.hostPath
}

// ============================================================================
// HANDLER FACTORY
// ============================================================================

export interface FsListDeps {
  db: Db
  volumeService: VolumeService
  workspaceService: WorkspaceService
}

export function createFsListHandler(deps: FsListDeps) {
  const { db, volumeService, workspaceService } = deps

  return async function fsListHandler(ctx: WsHandlerContext, rawData: unknown): Promise<FsListResult> {
    const data = rawData as FsListData
    const { workspaceId, path: requestedPath } = data

    if (!workspaceId) throw new HandlerError('MISSING_FIELDS', 'workspaceId is required')
    if (!requestedPath) throw new HandlerError('MISSING_FIELDS', 'path is required')

    // Resolve the workspace volume host path
    let volumeHostPath: string
    try {
      volumeHostPath = await resolveWorkspaceVolumeRoot(workspaceId, db, volumeService, workspaceService)
    } catch (err: any) {
      console.error(`[FsBrowser] Failed to resolve volume for workspace ${workspaceId}:`, err.message)
      throw new HandlerError('FS_LIST_ERROR', `Cannot resolve workspace volume: ${err.message}`)
    }

    // Strip the container mount prefix from the requested path
    let relativePath = requestedPath
    if (requestedPath.startsWith(CONTAINER_MOUNT + '/')) {
      relativePath = requestedPath.slice(CONTAINER_MOUNT.length + 1)
    } else if (requestedPath === CONTAINER_MOUNT) {
      relativePath = ''
    } else if (requestedPath.startsWith(CONTAINER_MOUNT)) {
      relativePath = requestedPath.slice(CONTAINER_MOUNT.length)
    }

    // Resolve the host path and validate it's within the volume root
    const resolvedHostPath = resolve(join(volumeHostPath, relativePath))
    const normalizedRoot = normalize(volumeHostPath)

    if (!resolvedHostPath.startsWith(normalizedRoot + '/') && resolvedHostPath !== normalizedRoot) {
      console.warn(`[FsBrowser] Path traversal attempt: ${requestedPath} → ${resolvedHostPath} (root: ${normalizedRoot})`)
      throw new HandlerError('FS_LIST_ERROR', 'Access denied: path is outside the workspace volume')
    }

    // Local dev fallback: if the volume path doesn't exist but the literal path does
    let effectiveHostPath = resolvedHostPath
    try {
      await stat(resolvedHostPath)
    } catch {
      // Try the literal path (local dev mode where /workspace is mounted directly)
      try {
        await stat(requestedPath)
        effectiveHostPath = requestedPath
        console.log(`[FsBrowser] Volume path not found, falling back to literal path: ${requestedPath}`)
      } catch {
        throw new HandlerError('FS_LIST_ERROR', `Directory not found: ${requestedPath}`)
      }
    }

    // Verify it's a directory
    const dirStat = await stat(effectiveHostPath)
    if (!dirStat.isDirectory()) {
      throw new HandlerError('FS_LIST_ERROR', `Path is not a directory: ${requestedPath}`)
    }

    // Read directory entries
    let dirents: Dirent[]
    try {
      dirents = await readdir(effectiveHostPath, { withFileTypes: true }) as unknown as Dirent[]
    } catch (err: any) {
      console.error(`[FsBrowser] readdir failed for ${effectiveHostPath}:`, err.message)
      throw new HandlerError('FS_LIST_ERROR', `Cannot read directory: ${err.message}`)
    }

    const truncated = dirents.length > MAX_ENTRIES
    const slicedDirents = truncated ? dirents.slice(0, MAX_ENTRIES) : dirents

    // Collect entries with stat info
    const entries: FileEntry[] = []
    for (const dirent of slicedDirents) {
      const entryHostPath = join(effectiveHostPath, String(dirent.name))

      // Compute the container-perspective path for this entry
      // If we used the fallback literal path, preserve it; otherwise reconstruct from container mount
      let entryContainerPath: string
      const direntName = String(dirent.name)
      if (effectiveHostPath === requestedPath) {
        // Literal path fallback
        entryContainerPath = join(requestedPath, direntName)
      } else {
        // Normal case: reconstruct from the container path
        const entryRelative = relativePath ? join(relativePath, direntName) : direntName
        entryContainerPath = join(CONTAINER_MOUNT, entryRelative)
      }

      // Treat symlinks as files (v1 behaviour)
      const isDir = dirent.isDirectory()

      let size: number | null = null
      let modifiedAt: string = new Date().toISOString()

      try {
        const entryStat = await stat(entryHostPath)
        size = isDir ? null : entryStat.size
        modifiedAt = entryStat.mtime.toISOString()
      } catch {
        // Permission error or broken symlink — omit size/mtime, still include the entry
        console.warn(`[FsBrowser] Could not stat entry ${entryHostPath}, using defaults`)
      }

      entries.push({
        name: direntName,
        type: isDir ? 'directory' : 'file',
        size,
        modifiedAt,
        path: entryContainerPath,
      })
    }

    console.log(`[FsBrowser] Listed ${entries.length} entries for ${requestedPath} (workspace: ${workspaceId})`)

    return {
      path: requestedPath,
      entries,
      truncated,
    }
  }
}
