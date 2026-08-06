/**
 * Shared utility for resolving container-side file paths to host-side paths.
 *
 * Container paths (e.g. /workspace/file.html) need to be translated to the
 * actual host path where the backend can read them. The mapping goes through
 * the workspace volume stored in MongoDB.
 *
 * Consumed by: HttpFileHandler, FileWatcher, FsBrowserWrite.
 */

import { access } from 'fs/promises'
import { join } from 'path'
import type { Db } from 'mongodb'
import type { VolumeService } from '../services/volume-service'
import type { WorkspaceService } from '../services/workspace-service'

const CONTAINER_MOUNT = '/workspace'

/**
 * Resolves a container-side filePath to the host filesystem path.
 *
 * Accepts either a workspaceId (work_* / ws_*) or a channelId as context.
 * In local dev, falls back to the literal filePath if the volume-derived
 * path doesn't exist yet (e.g. VOLUMES_BASE_PATH not configured) — but ONLY
 * for paths under the container mount (/workspace). Arbitrary host paths
 * (/etc/passwd, ~/.ssh/...) must never be returned literally: callers feed
 * the result to fs.readFile/fs.watch, so an ungated fallback is an
 * authenticated arbitrary-file-read of the backend host.
 *
 * @param containerMount - Override of the container mount prefix (test-only;
 *                         production callers use the default '/workspace').
 */
export async function resolveVolumeHostPath(
  filePath: string,
  channelOrWorkspaceId: string,
  db: Db,
  volumeService: VolumeService,
  workspaceService: WorkspaceService | null,
  containerMount: string = CONTAINER_MOUNT,
): Promise<string> {
  let volumeHostPath: string

  const isWorkspaceId =
    channelOrWorkspaceId.startsWith('work_') || channelOrWorkspaceId.startsWith('ws_')

  if (isWorkspaceId) {
    if (!workspaceService) throw new Error('[VolumePathResolver] WorkspaceService unavailable')
    const workspace = await workspaceService.getWorkspace(channelOrWorkspaceId)
    if (!workspace?.volumeId) throw new Error(`Workspace has no volume: ${channelOrWorkspaceId}`)
    const vol = await volumeService.getVolume(workspace.volumeId)
    if (!vol) throw new Error(`Volume not found: ${workspace.volumeId}`)
    volumeHostPath = vol.hostPath
  } else {
    const channelsCol = db.collection<any>('channels')
    const channel = await channelsCol.findOne({ channelId: channelOrWorkspaceId })
    if (!channel) throw new Error(`Channel not found: ${channelOrWorkspaceId}`)

    if (channel.workspaceId && workspaceService) {
      const workspace = await workspaceService.getWorkspace(channel.workspaceId)
      if (!workspace?.volumeId) throw new Error(`Workspace has no volume: ${channel.workspaceId}`)
      const vol = await volumeService.getVolume(workspace.volumeId)
      if (!vol) throw new Error(`Volume not found: ${workspace.volumeId}`)
      volumeHostPath = vol.hostPath
    } else {
      throw new Error(
        `[VolumePathResolver] Cannot resolve volume: channel ${channelOrWorkspaceId} has no workspaceId`,
      )
    }
  }

  const mountPrefix = `${containerMount}/`

  let relativePath = filePath
  if (filePath.startsWith(mountPrefix)) {
    relativePath = filePath.slice(mountPrefix.length)
  } else if (filePath.startsWith(containerMount)) {
    relativePath = filePath.slice(containerMount.length)
  }
  // Reject only literal '..' segments (allow names like '..foo' or 'foo..bar')
  if (relativePath.split('/').includes('..')) {
    throw new Error('Invalid file path: path traversal detected')
  }

  const resolvedPath = join(volumeHostPath, relativePath)
  return accessOrFallback(resolvedPath, filePath, mountPrefix)
}

/**
 * Returns `resolvedPath` if it exists. Local dev fallback: if it doesn't but the
 * literal `filePath` does (backend and MCA share a filesystem, VOLUMES_BASE_PATH
 * unset), use the literal — but ONLY for paths under the container mount.
 *
 * SECURITY: an ungated literal fallback lets an authenticated client read any
 * existing host file (/etc/passwd) via file.watch / fs.write, because callers
 * fs.readFile/fs.watch the result. The mount-prefix gate closes that.
 */
async function accessOrFallback(resolvedPath: string, filePath: string, mountPrefix: string): Promise<string> {
  try {
    await access(resolvedPath)
    return resolvedPath
  } catch {
    if (!filePath.startsWith(mountPrefix)) return resolvedPath
    try {
      await access(filePath)
      console.log(`[VolumePathResolver] Volume path not found, falling back to literal: ${filePath}`)
      return filePath
    } catch {
      // Neither exists yet — return volume path and let caller handle it
      return resolvedPath
    }
  }
}
