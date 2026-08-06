/**
 * FileShareApi — REST client for the file-share endpoints
 *
 * Uses fetch() with Bearer token auth (no WebSocket needed).
 *
 * Endpoints (backend):
 *   POST   /api/share          — Publish a file → { shareId, filePath, createdAt }
 *   GET    /api/share?filePath= — Get existing share for a file → { shareId, ... } | 404
 *   DELETE /api/share/:shareId — Unpublish a file
 *
 * Public URL for a share:
 *   <backendBaseUrl>/share/<shareId>
 */

// ============================================================================
// Types
// ============================================================================

export interface ShareInfo {
  shareId: string
  filePath: string
  createdAt: string
}

// ============================================================================
// FileShareApi
// ============================================================================

export class FileShareApi {
  constructor(
    private readonly getBaseUrl: () => string,
    private readonly getToken: () => string | null,
  ) {}

  private headers(): Record<string, string> {
    const token = this.getToken()
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  /**
   * Publish a file and return its share info.
   * If already shared, returns the existing share.
   */
  async share(filePath: string, channelId: string, fileType: 'html' | 'markdown'): Promise<ShareInfo> {
    const res = await fetch(`${this.getBaseUrl()}/api/share`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ filePath, channelId, fileType }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error((err as any).error ?? `HTTP ${res.status}`)
    }
    return res.json() as Promise<ShareInfo>
  }

  /**
   * Get existing share info for a file path.
   * Returns null if the file is not currently shared.
   *
   * Pass `workspaceId` to disambiguate the lookup when the same filePath
   * exists in multiple workspaces owned by the user.
   */
  async getShare(filePath: string, workspaceId?: string): Promise<ShareInfo | null> {
    const params = new URLSearchParams({ filePath })
    if (workspaceId) params.set('workspaceId', workspaceId)
    const url = `${this.getBaseUrl()}/api/share?${params.toString()}`
    const res = await fetch(url, { headers: this.headers() })
    if (res.status === 404) return null
    if (!res.ok) return null
    return res.json() as Promise<ShareInfo>
  }

  /**
   * Unpublish a file by shareId.
   */
  async unshare(shareId: string): Promise<void> {
    const res = await fetch(`${this.getBaseUrl()}/api/share/${shareId}`, {
      method: 'DELETE',
      headers: this.headers(),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error((err as any).error ?? `HTTP ${res.status}`)
    }
  }

  /**
   * Build the public URL for a shareId.
   */
  publicUrl(shareId: string): string {
    return `${this.getBaseUrl()}/share/${shareId}`
  }
}
