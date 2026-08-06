/**
 * FileBrowserApi — Typed client for the fs-browser domain
 *
 * Sends fs.list and fs.write requests via the WsFramework request/response protocol.
 *
 * fs.list:  { workspaceId: string, path: string } → { path, entries, truncated }
 * fs.write: { workspaceId: string, filePath: string, content: string } → { filePath, bytesWritten }
 */

import type { Transport } from './transport/types'

// ============================================================================
// Types
// ============================================================================

export interface FileEntry {
  name: string
  type: 'file' | 'directory'
  size: number | null    // bytes; null for directories
  modifiedAt: string     // ISO 8601
  path: string           // absolute path inside the volume (container perspective)
}

export interface DirectoryListing {
  path: string
  entries: FileEntry[]
  truncated: boolean
}

export interface FsWriteResult {
  filePath: string
  bytesWritten: number
}

// ============================================================================
// FileBrowserApi
// ============================================================================

export class FileBrowserApi {
  constructor(private readonly transport: Transport) {}

  /**
   * List the contents of a directory within a workspace volume.
   *
   * @param workspaceId  Workspace ID — used to resolve the correct volume
   * @param path         Absolute path inside the container (e.g. '/workspace/src')
   */
  list(workspaceId: string, path: string): Promise<DirectoryListing> {
    return this.transport.request<DirectoryListing>('fs.list', { workspaceId, path })
  }

  /**
   * Write content to a file within a workspace volume.
   *
   * @param workspaceId  Workspace ID — used to resolve the correct volume
   * @param filePath     Absolute path inside the container (e.g. '/workspace/src/index.ts')
   * @param content      UTF-8 string content to write
   */
  write(workspaceId: string, filePath: string, content: string): Promise<FsWriteResult> {
    return this.transport.request<FsWriteResult>('fs.write', { workspaceId, filePath, content })
  }
}
