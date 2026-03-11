/**
 * FileWatcherApi — Typed client for the file-watcher domain
 *
 * Replaces the raw legacy watchFile / unwatchFile methods in TerosClient.
 * Uses the WsFramework request/response protocol via WsTransport.
 *
 * Real-time events are pushed by the backend as:
 *   { type: 'event', event: 'file.changed', channel: 'file:<path>', data: { filePath, content } }
 *
 * Listen for changes with:
 *   client.on('file.changed', ({ filePath, content }) => { ... })
 */

import type { WsTransport } from './WsTransport'

// ============================================================================
// Types
// ============================================================================

export interface WatchFileResult {
  filePath: string
  watching: boolean
}

export interface UnwatchFileResult {
  filePath: string
  watching: boolean
}

// ============================================================================
// FileWatcherApi
// ============================================================================

export class FileWatcherApi {
  constructor(private readonly transport: WsTransport) {}

  /**
   * Ask the backend to watch a file for changes.
   *
   * The backend resolves the host path, subscribes this client to the
   * `file:<filePath>` channel, sends the current content immediately, and
   * pushes `file.changed` events on every subsequent save.
   *
   * Listen with: client.on('file.changed', ({ filePath, content }) => { ... })
   */
  watch(filePath: string, channelId: string): Promise<WatchFileResult> {
    return this.transport.request<WatchFileResult>('file.watch', { filePath, channelId })
  }

  /**
   * Stop watching a file.
   * Closes the fs.watch watcher and unsubscribes from the `file:<filePath>` channel.
   */
  unwatch(filePath: string): Promise<UnwatchFileResult> {
    return this.transport.request<UnwatchFileResult>('file.unwatch', { filePath })
  }
}
