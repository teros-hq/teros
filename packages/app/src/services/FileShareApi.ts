/**
 * FileShareApi — client for the share domain over the app WebSocket
 *
 * Uses the WsFramework request/response protocol via WsTransport — same
 * transport every other domain API uses. Replaces the old REST client
 * (fetch to /api/share) per the platform's WS-first architecture rule.
 *
 * Backend actions (WS domain `share`):
 *   share.create — Publish a file → { shareId, url }
 *   share.get    — Get existing share for a file → { shared, shareId?, url? }
 *   share.revoke — Unpublish a file → { ok, shareId }
 *
 * Public URL for a share (the ONLY remaining HTTP surface — it IS the link):
 *   <backendBaseUrl>/share/<shareId>
 */

import type { Transport } from './transport/types'

// ============================================================================
// Types
// ============================================================================

export interface ShareInfo {
  shareId: string
  filePath?: string
  createdAt?: string
}

interface ShareCreateResult {
  shareId: string
  url: string
}

interface ShareGetResult {
  shared: boolean
  shareId?: string
  url?: string
}

interface ShareRevokeResult {
  ok: boolean
  shareId: string
}

// ============================================================================
// FileShareApi
// ============================================================================

export class FileShareApi {
  constructor(
    private readonly transport: Transport,
    private readonly getBaseUrl: () => string,
  ) {}

  /**
   * Publish a file and return its share info.
   * If already shared, the backend creates a new share (idempotency is left
   * to the caller — use getShare first when reuse matters).
   */
  async share(
    filePath: string,
    channelId: string,
    fileType: 'html' | 'markdown' | 'file',
  ): Promise<ShareInfo> {
    const result = await this.transport.request<ShareCreateResult>('share.create', {
      filePath,
      channelId,
      fileType,
    })
    return { shareId: result.shareId }
  }

  /**
   * Get existing share info for a file path.
   * Returns null if the file is not currently shared.
   *
   * Pass `workspaceId` to disambiguate the lookup when the same filePath
   * exists in multiple workspaces owned by the user.
   */
  async getShare(filePath: string, workspaceId?: string): Promise<ShareInfo | null> {
    const result = await this.transport.request<ShareGetResult>('share.get', {
      filePath,
      ...(workspaceId ? { workspaceId } : {}),
    })
    if (!result.shared || !result.shareId) return null
    return { shareId: result.shareId }
  }

  /**
   * Unpublish a file by shareId.
   */
  async unshare(shareId: string): Promise<void> {
    await this.transport.request<ShareRevokeResult>('share.revoke', { shareId })
  }

  /**
   * Build the public URL for a shareId.
   * This is the public HTTP link itself (GET /share/:shareId) — not an API call.
   */
  publicUrl(shareId: string): string {
    return `${this.getBaseUrl()}/share/${shareId}`
  }
}
