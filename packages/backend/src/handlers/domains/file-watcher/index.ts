/**
 * file-watcher domain — registers file watch/unwatch handlers with the router
 *
 * Actions:
 *   file.watch   → Start watching a file; subscribes client to `file:<path>` channel
 *   file.unwatch → Stop watching a file; unsubscribes client from `file:<path>` channel
 *
 * Real-time events (pushed via SubscriptionManager):
 *   { type: 'event', event: 'file.changed', channel: 'file:<path>', data: { filePath, content } }
 *
 * Lifecycle:
 *   - file.watch  → resolves hostPath via VolumeService, starts fs.watch
 *   - file.unwatch → stops the watcher for that path
 *   - WS close    → all watchers for that connection are cleaned up via cleanupWatcherRegistry
 */

import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { Db } from 'mongodb'
import type { VolumeService } from '../../../services/volume-service'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { SubscriptionManager } from '../../../ws-framework/SubscriptionManager'
import type { WebSocket } from 'ws'
import type { WatcherRegistry } from './watch'
import { createWatchFileHandler } from './watch'
import { createUnwatchFileHandler } from './unwatch'

export { createWatcherRegistry, cleanupWatcherRegistry } from './watch'
export type { WatcherRegistry } from './watch'

// ============================================================================
// DOMAIN DEPS
// ============================================================================

export interface FileWatcherDomainDeps {
  db: Db
  volumeService: VolumeService
  workspaceService: WorkspaceService | null
  subscriptionManager: SubscriptionManager
  /** Returns (or lazily creates) the per-connection watcher registry */
  getRegistry: (ws: WebSocket) => WatcherRegistry
}

// ============================================================================
// REGISTER
// ============================================================================

export function register(router: WsRouter, deps: FileWatcherDomainDeps): void {
  router.register('file.watch', createWatchFileHandler(deps))
  router.register('file.unwatch', createUnwatchFileHandler(deps))
}
