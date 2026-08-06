/**
 * file.watch — Start watching a file for changes
 *
 * Resolves the host path for the given file, sends the current content
 * immediately, then subscribes the client to the `file:<filePath>` channel
 * via PubSubService. Subsequent changes are pushed as `file_changed`
 * events to all subscribers.
 */

import { readFile, access } from 'fs/promises'
import { watch, type FSWatcher } from 'fs'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { Db } from 'mongodb'
import type { VolumeService } from '../../../services/volume-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { WebSocket } from 'ws'
import { resolveVolumeHostPath } from '../../../lib/volume-path-resolver'

type WsCtx = WsHandlerContext & { ws: WebSocket }

// ============================================================================
// TYPES
// ============================================================================

interface WatchFileData {
  filePath: string
  /** Channel ID — used to resolve the workspace volume. Mutually exclusive with workspaceId. */
  channelId?: string
  /** Workspace ID — used to resolve the workspace volume directly (e.g. from FileBrowser). Mutually exclusive with channelId. */
  workspaceId?: string
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

export { resolveVolumeHostPath as resolveHostPath } from '../../../lib/volume-path-resolver'

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
    try { entry.watcher.close() } catch { /* intentional: watcher may already be closed — cleanup only */ }
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
  pubSubService: PubSubService
  /** Resolve sessionId from a WebSocket connection — used to subscribe/unsubscribe */
  getSessionId: (ws: WebSocket) => string | undefined
  /** Per-connection watcher registry — injected by websocket-handler */
  getRegistry: (ws: WebSocket) => WatcherRegistry
  /** waitForFile tuning (test-only). Production default: 10 retries × 500 ms. */
  waitForFileRetries?: number
  waitForFileDelayMs?: number
}

export function createWatchFileHandler(deps: WatchFileDeps) {
  const { db, volumeService, workspaceService, pubSubService, getSessionId, getRegistry } = deps

  return async function watchFile(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as WatchFileData
    const { filePath, channelId, workspaceId } = data

    if (!filePath) throw new HandlerError('MISSING_FIELDS', 'filePath is required')
    if (!channelId && !workspaceId) throw new HandlerError('MISSING_FIELDS', 'channelId or workspaceId is required')

    // Use whichever context identifier was provided
    const contextId = (workspaceId ?? channelId)!

    const ws = (ctx as WsCtx).ws
    const sessionId = getSessionId(ws)
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
      hostPath = await resolveVolumeHostPath(filePath, contextId, db, volumeService, workspaceService)
    } catch (err: any) {
      console.error(`[FileWatcher] Failed to resolve path for ${filePath}:`, err.message)
      throw new HandlerError('FILE_WATCHER_ERROR', `Cannot resolve file path: ${err.message}`)
    }

    console.log(`[FileWatcher] Watching ${filePath} → ${hostPath}`)

    // Subscribe the client to the file topic via PubSubService
    const fileTopic = `file:${filePath}`
    if (sessionId) {
      pubSubService.subscribeSession(sessionId, fileTopic)
    }

    // Wait for the file to exist before calling fs.watch (race condition fix:
    // the frontend may request a watch before the agent has written the file).
    try {
      await waitForFile(hostPath, deps.waitForFileRetries, deps.waitForFileDelayMs)
    } catch (err: any) {
      console.error(`[FileWatcher] File never appeared at ${hostPath}:`, err.message)
      if (sessionId) pubSubService.unsubscribeSession(sessionId, fileTopic)
      throw new HandlerError('FILE_WATCHER_ERROR', `Cannot watch file: ${err.message}`)
    }

    // Send current content immediately so the FileViewer has something to show
    try {
      const content = await readFile(hostPath, 'utf-8')
      pubSubService.broadcastToTopic(fileTopic, {
        type: 'event',
        event: 'file_changed',
        channel: fileTopic,
        data: { filePath, content },
      })
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
            pubSubService.broadcastToTopic(fileTopic, {
              type: 'event',
              event: 'file_changed',
              channel: fileTopic,
              data: { filePath, content },
            })
          } catch (err: any) {
            console.warn(`[FileWatcher] Could not read file ${hostPath}:`, err.message)
          }
        }, 300)
      })
    } catch (err: any) {
      console.error(`[FileWatcher] fs.watch failed for ${hostPath}:`, err.message)
      if (sessionId) pubSubService.unsubscribeSession(sessionId, fileTopic)
      throw new HandlerError('FILE_WATCHER_ERROR', `Cannot watch file: ${err.message}`)
    }

    registry.set(filePath, { watcher: fsWatcher, hostPath, debounceTimer: null })

    return { filePath, watching: true }
  }
}
