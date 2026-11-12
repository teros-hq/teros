/**
 * FileBrowserApi — Typed client for the fs-browser domain
 *
 * Sends fs.list and fs.write requests via the WsFramework request/response protocol.
 * Also provides downloadFile() via the HTTP /api/files endpoint.
 *
 * fs.list:      { workspaceId: string, path: string } → { path, entries, truncated }
 * fs.write:     { workspaceId: string, filePath: string, content: string } → { filePath, bytesWritten }
 * downloadFile: HTTP GET /api/files?path=...&workspaceId=...&download=true
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
  constructor(
    private readonly transport: Transport,
    private readonly getBaseUrl?: () => string,
    private readonly getToken?: () => string | null,
  ) {}

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

  /**
   * Download a file from the workspace volume via HTTP.
   * Triggers a browser download with Content-Disposition: attachment.
   *
   * Web only — no-ops on native platforms where `document` is unavailable.
   */
  async downloadFile(workspaceId: string, filePath: string): Promise<void> {
    if (typeof document === 'undefined') return
    if (!this.getBaseUrl || !this.getToken) return

    const baseUrl = this.getBaseUrl()
    const token = this.getToken()

    const params = new URLSearchParams({
      path: filePath,
      workspaceId,
      download: 'true',
    })

    const url = `${baseUrl}/api/files?${params.toString()}`

    // Use fetch with auth header, then create a blob and trigger download
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Download failed' }))
      throw new Error((err as any).error ?? `HTTP ${res.status}`)
    }

    const blob = await res.blob()
    const blobUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = blobUrl
    // Extract filename from path — the Content-Disposition header also has it,
    // but setting it here ensures it works even if the browser ignores the header.
    const filename = filePath.split('/').pop() ?? 'download'
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(blobUrl)
  }
}
