/**
 * HTTP File Handler
 *
 * Serves workspace files for the HtmlFileBubble component and the File Browser.
 * Endpoint: GET /api/files?path=/workspace/foo.html&workspaceId=work_xxx
 *           GET /api/files?path=/workspace/foo.html&channelId=ch_xxx
 *           GET /api/files?path=...&workspaceId=...&download=true
 *
 * When download=true, the response includes Content-Disposition: attachment
 * and the file is read as a binary Buffer with a best-effort MIME type.
 *
 * Auth: Bearer token in Authorization header only.
 */

import { readFile } from 'fs/promises';
import { basename, extname } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from 'mongodb';
import type { AuthService } from '../auth/auth-service';
import type { ChannelManager } from '../services/channel-manager';
import type { VolumeService } from '../services/volume-service';
import type { WorkspaceService } from '../services/workspace-service';
import { resolveVolumeHostPath } from '../lib/volume-path-resolver';
import { extractSessionToken } from '../lib/session-cookie';

// ============================================================================
// MIME type lookup (minimal — covers common workspace file types)
// ============================================================================

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

// ============================================================================

export class HttpFileHandler {
  constructor(
    private db: Db,
    private authService: AuthService,
    private volumeService: VolumeService,
    private workspaceService: WorkspaceService | null,
    private channelManager: ChannelManager | null,
  ) {}

  async handleRoute(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    if (!url.startsWith('/api/files')) return false;

    const method = req.method || 'GET';
    if (method !== 'GET') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return true;
    }

    // Parse query params
    const parsed = new URL(url, `http://${req.headers.host}`);
    const filePath    = parsed.searchParams.get('path');
    const channelId   = parsed.searchParams.get('channelId');
    const workspaceId = parsed.searchParams.get('workspaceId');
    const download    = parsed.searchParams.get('download') === 'true';

    console.log('[HttpFileHandler] GET /api/files — raw url:', url, '| path:', filePath, '| workspaceId:', workspaceId, '| channelId:', channelId, '| download:', download);

    if (!filePath || (!channelId && !workspaceId)) {
      console.warn('[HttpFileHandler] Missing params — path:', filePath, 'channelId:', channelId, 'workspaceId:', workspaceId);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required params: path and (workspaceId or channelId)' }));
      return true;
    }

    // Authenticate
    const userId = await this.getUserId(req);
    if (!userId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }

    // SEC-2 (TER-721 / A3): authorize the SAME context we resolve against, with
    // the SAME precedence (workspaceId over channelId). Without this any logged-in
    // user could read another workspace's files by passing its id in the query.
    const authorized = workspaceId
      ? await (this.workspaceService?.canAccess(workspaceId, userId) ?? Promise.resolve(false))
      : await (this.channelManager?.canAccessChannel(channelId!, userId) ?? Promise.resolve(false));
    if (!authorized) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return true;
    }

    // Resolve host path — prefer workspaceId (direct fast-path) over channelId (requires DB lookup)
    const contextId = workspaceId ?? channelId!;
    let hostPath: string;
    try {
      hostPath = await resolveVolumeHostPath(filePath, contextId, this.db, this.volumeService, this.workspaceService);
    } catch (err: any) {
      console.error('[HttpFileHandler] Path resolution error:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return true;
    }

    // Read file — binary Buffer for downloads, utf-8 for inline viewing
    try {
      if (download) {
        // ── Download mode: binary read + Content-Disposition: attachment ──────
        const content = await readFile(hostPath); // Buffer (no encoding)
        const filename = basename(filePath);
        const mimeType = getMimeType(filePath);

        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': content.length,
          'Cache-Control': 'no-cache',
        });
        res.end(content);
      } else {
        // ── Inline mode: text read (existing behaviour) ───────────────────────
        const content = await readFile(hostPath, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(content);
      }
    } catch (err: any) {
      console.error('[HttpFileHandler] Read error:', err.message);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
    }

    return true;
  }

  private async getUserId(req: IncomingMessage): Promise<string | null> {
    // Authorization: Bearer <token> (primary) or teros_session cookie (F2:
    // web after reload has no in-memory token; the cookie is httpOnly and
    // same-site). Same validation path either way.
    const token = extractSessionToken(req);
    if (token) {
      const result = await this.authService.validateSession(token);
      return result.success ? (result.user?.userId ?? null) : null;
    }
    return null;
  }

}
