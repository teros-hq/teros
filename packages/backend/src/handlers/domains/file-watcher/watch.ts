/**
 * file.watch — Start watching a file for changes
 *
 * Resolves the host path for the given file, sends the current content
 * immediately, then subscribes the client to the `file:<filePath>` channel
 * via SubscriptionManager. Subsequent changes are pushed as `file.changed`
 * events to all subscribers.
 */

import { readFile, access } from 'fs/promises'
import { watch, type FSWatcher } from 'fs'
import { join } from 'path'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { VolumeService } from '../../../services/volume-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { SubscriptionManager } from '../../../ws-framework/SubscriptionManager'
import type { WebSocket } from 'ws'

type WsCtx = WsHandlerContext & { ws: WebSocket }

// ============================================================================
// TYPES
// ============================================================================

interface WatchFileData {
  filePath: string
  channelId: string
}

/** One active watcher entry */
interface WatcherEntry {
  watcher: FSWatcher
  hostPath: string
  /** Debounce timer to avoid double-firing on rapid saves */
  debounceTimer: NodeJS.Timeout | null
}

// ============================================================================
// PATH RESOLVER (shared helper)
// ============================================================================

const CONTAINER_MOUNT = '/workspace'

export async function resolveHostPath(
  filePath: string,
  channelId: string,
  db: Db,
  volumeService: VolumeService,
  workspaceService: WorkspaceService | null,
): Promise<string> {
  const channelsCol = db.collection<any>('channels')
  const channel = await channelsCol.findOne({ channelId })
  if (!channel) throw new Error(`Channel not found: ${channelId}`)

  let volumeHostPath: string

  if (channel.workspaceId && workspaceService) {
    const workspace = await workspaceService.getWorkspace(channel.workspaceId)
    if (!workspace?.volumeId) throw new Error(`Workspace has no volume: ${channel.workspaceId}`)
    const vol = await volumeService.getVolume(workspace.volumeId)
    if (!vol) throw new Error(`Volume not found: ${workspace.volumeId}`)
    volumeHostPath = vol.hostPath
  } else {
    console.log('[FileWatcher] getUserVolume — userId:', channel.userId)
    const vol = await volumeService.getUserVolume(channel.userId)
    console.log('[FileWatcher] getUserVolume result:', vol ? vol.volumeId : 'null/undefined')
    if (!vol) throw new Error(`Volume not found for user: ${channel.userId}`)
    volumeHostPath = vol.hostPath
  }

  // Strip any container mount prefix and join with volume host path.
  let relativePath = filePath
  if (filePath.startsWith(CONTAINER_MOUNT + '/')) {
    relativePath = filePath.slice(CONTAINER_MOUNT.length + 1)
  } else if (filePath.startsWith(CONTAINER_MOUNT)) {
    relativePath = filePath.slice(CONTAINER_MOUNT.length)
  }
  if (relativePath.includes('..')) throw new Error('Invalid file path: path traversal detected')

  const resolvedPath = join(volumeHostPath, relativePath)

  // Local dev fallback: if the volume-derived path doesn't exist but the
  // filePath itself does (e.g. backend and MCA share the same filesystem),
  // use it directly. This handles the case where VOLUMES_BASE_PATH is not
  // configured and the file lives at its literal path on disk.
  try {
    await access(resolvedPath)
    return resolvedPath
  } catch {
    try {
      await access(filePath)
      console.log(`[FileWatcher] Volume path not found, falling back to literal path: ${filePath}`)
      return filePath
    } catch {
      // Neither exists yet — return the volume path and let waitForFile handle it
      return resolvedPath
    }
  }
}

// ============================================================================
// WATCHER REGISTRY
// ============================================================================

/**
 * Per-connection watcher registry.
 * Key: filePath (as provided by client, e.g. '/workspace/mockup.html')
 */
export type WatcherRegistry = Map<string, WatcherEntry>

/** Create a fresh registry for a new connection */
export function createWatcherRegistry(): WatcherRegistry {
  return new Map()
}

/** Stop and remove all watchers for a connection (call on disconnect) */
export function cleanupWatcherRegistry(registry: WatcherRegistry): void {
  for (const [filePath, entry] of registry.entries()) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    try { entry.watcher.close() } catch {}
    console.log(`[FileWatcher] Cleanup: stopped watching ${filePath}`)
  }
  registry.clear()
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Polls for a file to exist using fs.access, retrying up to `maxRetries` times
 * with `delayMs` between attempts. Resolves when the file exists, rejects with
 * a clear error if it never appears within the timeout window.
 */
async function waitForFile(
  filePath: string,
  maxRetries = 10,
  delayMs = 500,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await access(filePath)
      return // file exists ✓
    } catch {
      if (attempt === maxRetries) {
        throw new Error(
          `File not found after ${maxRetries * delayMs}ms: ${filePath}`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

// ============================================================================
// HANDLER FACTORY
// ============================================================================

export interface WatchFileDeps {
  db: Db
  volumeService: VolumeService
  workspaceService: WorkspaceService | null
  subscriptionManager: SubscriptionManager
  /** Per-connection watcher registry — injected by websocket-handler */
  getRegistry: (ws: WebSocket) => WatcherRegistry
}

export function createWatchFileHandler(deps: WatchFileDeps) {
  const { db, volumeService, workspaceService, subscriptionManager, getRegistry } = deps

  return async function watchFile(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as WatchFileData
    const { filePath, channelId } = data

    if (!filePath) throw new HandlerError('MISSING_FIELDS', 'filePath is required')
    if (!channelId) throw new HandlerError('MISSING_FIELDS', 'channelId is required')

    const ws = (ctx as WsCtx).ws
    const registry = getRegistry(ws)

    // If already watching this path, stop the old watcher first
    if (registry.has(filePath)) {
      const existing = registry.get(filePath)!
      if (existing.debounceTimer) clearTimeout(existing.debounceTimer)
      existing.watcher.close()
      registry.delete(filePath)
    }

    let hostPath: string
    try {
      hostPath = await resolveHostPath(filePath, channelId, db, volumeService, workspaceService)
    } catch (err: any) {
      console.error(`[FileWatcher] Failed to resolve path for ${filePath}:`, err.message)
      throw new HandlerError('FILE_WATCHER_ERROR', `Cannot resolve file path: ${err.message}`)
    }

    console.log(`[FileWatcher] Watching ${filePath} → ${hostPath}`)

    // Subscribe the client to the file channel
    const fileChannel = `file:${filePath}`
    subscriptionManager.subscribe(ws, fileChannel)

    // Wait for the file to exist before calling fs.watch (race condition fix:
    // the frontend may request a watch before the agent has written the file).
    try {
      await waitForFile(hostPath)
    } catch (err: any) {
      console.error(`[FileWatcher] File never appeared at ${hostPath}:`, err.message)
      subscriptionManager.unsubscribe(ws, fileChannel)
      throw new HandlerError('FILE_WATCHER_ERROR', `Cannot watch file: ${err.message}`)
    }

    // Send current content immediately so the FileViewer has something to show
    try {
      const content = await readFile(hostPath, 'utf-8')
      subscriptionManager.publish(fileChannel, 'file.changed', { filePath, content })
    } catch (err: any) {
      console.warn(`[FileWatcher] Could not read file ${hostPath}:`, err.message)
    }

    let fsWatcher: FSWatcher
    try {
      fsWatcher = watch(hostPath, (eventType) => {
        if (eventType !== 'change' && eventType !== 'rename') return

        const entry = registry.get(filePath)
        if (!entry) return

        // Debounce: editors and tools often fire multiple rapid events on a
        // single save, and the file may not be fully flushed to disk when the
        // first event fires. 300 ms gives the OS time to complete the write.
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
        entry.debounceTimer = setTimeout(async () => {
          try {
            const content = await readFile(hostPath, 'utf-8')
            subscriptionManager.publish(fileChannel, 'file.changed', { filePath, content })
          } catch (err: any) {
            console.warn(`[FileWatcher] Could not read file ${hostPath}:`, err.message)
          }
        }, 300)
      })
    } catch (err: any) {
      console.error(`[FileWatcher] fs.watch failed for ${hostPath}:`, err.message)
      subscriptionManager.unsubscribe(ws, fileChannel)
      throw new HandlerError('FILE_WATCHER_ERROR', `Cannot watch file: ${err.message}`)
    }

    registry.set(filePath, { watcher: fsWatcher, hostPath, debounceTimer: null })

    return { filePath, watching: true }
  }
}
