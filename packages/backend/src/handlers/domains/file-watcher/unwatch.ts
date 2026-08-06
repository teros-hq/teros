/**
 * file.unwatch — Stop watching a file
 *
 * Closes the fs.watch watcher and unsubscribes the client from the
 * `file:<filePath>` topic via PubSubService.
 */

import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { PubSubService } from '../../../services/pubsub-service'
import type { WatcherRegistry } from './watch'
import type { WebSocket } from 'ws'

type WsCtx = WsHandlerContext & { ws: WebSocket }

// ============================================================================
// TYPES
// ============================================================================

interface UnwatchFileData {
  filePath: string
}

// ============================================================================
// HANDLER FACTORY
// ============================================================================

export interface UnwatchFileDeps {
  pubSubService: PubSubService
  /** Resolve sessionId from a WebSocket connection */
  getSessionId: (ws: WebSocket) => string | undefined
  /** Per-connection watcher registry — injected by websocket-handler */
  getRegistry: (ws: WebSocket) => WatcherRegistry
}

export function createUnwatchFileHandler(deps: UnwatchFileDeps) {
  const { pubSubService, getSessionId, getRegistry } = deps

  return async function unwatchFile(ctx: WsHandlerContext, rawData: unknown) {
    const data = rawData as UnwatchFileData
    const { filePath } = data

    if (!filePath) throw new HandlerError('MISSING_FIELDS', 'filePath is required')

    const ws = (ctx as WsCtx).ws
    const sessionId = getSessionId(ws)
    const registry = getRegistry(ws)

    const entry = registry.get(filePath)
    if (entry) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.watcher.close()
      registry.delete(filePath)
      console.log(`[FileWatcher] Stopped watching ${filePath}`)
    }

    // Unsubscribe from the file topic
    if (sessionId) {
      pubSubService.unsubscribeSession(sessionId, `file:${filePath}`)
    }

    return { filePath, watching: false }
  }
}
