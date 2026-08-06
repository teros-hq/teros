/**
 * HTTP Share Handler
 *
 * Manages public share links for workspace files.
 *
 * Endpoints:
 *   POST   /api/share            — create a share link (authenticated)
 *   DELETE /api/share/:shareId   — revoke a share link (authenticated)
 *   GET    /share/:shareId       — serve shared file (public, no auth)
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from 'mongodb';
import { marked } from 'marked';
import type { AuthService } from '../auth/auth-service';
import type { VolumeService } from '../services/volume-service';
import type { WorkspaceService } from '../services/workspace-service';
import type { ShareService } from '../services/share-service';
import { canAccessWorkspace } from '../auth/workspace-access';

const CONTAINER_MOUNT = '/workspace';

// 404 page for expired or deleted share links
function notFoundPage(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Enlace no disponible</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #0f0f11;
      color: #e4e4e7;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      text-align: center;
      padding: 3rem 2.5rem;
      max-width: 480px;
      width: 100%;
    }
    .icon {
      font-size: 4rem;
      line-height: 1;
      margin-bottom: 1.5rem;
      opacity: 0.7;
    }
    h1 {
      font-size: 1.375rem;
      font-weight: 600;
      color: #fafafa;
      margin-bottom: 0.875rem;
      letter-spacing: -0.01em;
    }
    p {
      font-size: 0.9375rem;
      line-height: 1.65;
      color: #71717a;
    }
    .divider {
      width: 40px;
      height: 2px;
      background: #27272a;
      border-radius: 2px;
      margin: 1.75rem auto;
    }
    .badge {
      display: inline-block;
      font-size: 0.6875rem;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #52525b;
      background: #1c1c1f;
      border: 1px solid #27272a;
      border-radius: 999px;
      padding: 0.25rem 0.75rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔗</div>
    <h1>Este enlace ya no está disponible</h1>
    <div class="divider"></div>
    <p>El archivo puede haber sido despublicado o el enlace está roto.<br>Pídele al autor que te lo vuelva a compartir.</p>
    <div class="divider"></div>
    <span class="badge">404 · Not Found</span>
  </div>
</body>
</html>`;
}

// Minimal HTML wrapper for markdown rendering
function markdownPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 16px;
      line-height: 1.7;
      color: #1a1a1a;
      background: #fff;
      margin: 0;
      padding: 2rem 1rem;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    h1, h2, h3, h4, h5, h6 {
      line-height: 1.3;
      margin-top: 2rem;
      margin-bottom: 0.75rem;
    }
    h1 { font-size: 2rem; }
    h2 { font-size: 1.5rem; }
    h3 { font-size: 1.25rem; }
    p { margin: 0 0 1rem; }
    a { color: #0070f3; text-decoration: underline; }
    code {
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 0.875em;
      background: #f4f4f5;
      padding: 0.15em 0.4em;
      border-radius: 4px;
    }
    pre {
      background: #f4f4f5;
      padding: 1rem;
      border-radius: 8px;
      overflow-x: auto;
    }
    pre code {
      background: none;
      padding: 0;
      font-size: 0.9em;
    }
    blockquote {
      border-left: 4px solid #e2e8f0;
      margin: 1.5rem 0;
      padding: 0.5rem 1rem;
      color: #555;
    }
    img { max-width: 100%; height: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5rem 0;
    }
    th, td {
      border: 1px solid #e2e8f0;
      padding: 0.5rem 0.75rem;
      text-align: left;
    }
    th { background: #f8f9fa; font-weight: 600; }
    hr { border: none; border-top: 1px solid #e2e8f0; margin: 2rem 0; }
  </style>
</head>
<body>
  <div class="container">
    ${body}
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export class HttpShareHandler {
  constructor(
    private db: Db,
    private authService: AuthService,
    private volumeService: VolumeService,
    private workspaceService: WorkspaceService | null,
    private shareService: ShareService,
  ) {}

  async handleRoute(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    const method = req.method || 'GET';
    const parsedUrl = new URL(url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // POST /api/share — create share (authenticated)
    if (pathname === '/api/share' && method === 'POST') {
      return this.handleCreate(req, res);
    }

    // GET /api/share?filePath=... — get share info for a file (authenticated)
    if (pathname === '/api/share' && method === 'GET') {
      return this.handleGetByFilePath(req, res, parsedUrl);
    }

    // DELETE /api/share/:shareId — revoke share (authenticated)
    if (pathname.startsWith('/api/share/') && method === 'DELETE') {
      const shareId = pathname.slice('/api/share/'.length);
      return this.handleDelete(req, res, shareId);
    }

    // GET /share/:shareId — serve file (public)
    if (pathname.startsWith('/share/') && method === 'GET') {
      const shareId = pathname.slice('/share/'.length);
      return this.handleServe(req, res, shareId);
    }

    return false;
  }

  // ── POST /api/share ────────────────────────────────────────────────────────

  private async handleCreate(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const userId = await this.getUserId(req);
    if (!userId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }

    let body: { filePath?: string; channelId?: string; fileType?: string };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return true;
    }

    const { filePath, channelId, fileType } = body;

    if (!filePath || !channelId || !fileType) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields: filePath, channelId, fileType' }));
      return true;
    }

    if (fileType !== 'html' && fileType !== 'markdown') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'fileType must be "html" or "markdown"' }));
      return true;
    }

    // Resolve workspaceId from channel
    const channelsCol = this.db.collection<any>('channels');
    const channel = await channelsCol.findOne({ channelId });
    if (!channel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Channel not found: ${channelId}` }));
      return true;
    }

    const workspaceId: string = channel.workspaceId;
    if (!workspaceId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Channel has no associated workspace' }));
      return true;
    }

    // Workspace is sovereign: only members may share files from its volume. The WS path
    // (file-share/index.ts → resolveAuthorizedWorkspace) gates this; mirror it here so the
    // HTTP path the frontend uses cannot exfiltrate another workspace's file by passing a
    // foreign channelId. TER-551 — the TER-480/#172 fix closed the WS path but missed this one.
    if (!(await canAccessWorkspace(this.db, userId, workspaceId))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No access to this workspace' }));
      return true;
    }

    const { shareId, publicUrl } = await this.shareService.createShare(userId, filePath, workspaceId, fileType as 'html' | 'markdown');

    console.log(`[HttpShareHandler] Created share ${shareId} for user ${userId}, file: ${filePath}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ shareId, publicUrl }));
    return true;
  }

  // ── DELETE /api/share/:shareId ─────────────────────────────────────────────

  private async handleDelete(req: IncomingMessage, res: ServerResponse, shareId: string): Promise<boolean> {
    if (!shareId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing shareId' }));
      return true;
    }

    const userId = await this.getUserId(req);
    if (!userId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }

    try {
      await this.shareService.deleteShare(shareId, userId);
    } catch (err: any) {
      if (err.message?.includes('not found')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Share not found or not owned by you' }));
        return true;
      }
      if (err.message?.includes('Permission denied')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return true;
      }
      throw err;
    }

    console.log(`[HttpShareHandler] Deleted share ${shareId} by user ${userId}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // ── GET /share/:shareId ────────────────────────────────────────────────────

  private async handleServe(req: IncomingMessage, res: ServerResponse, shareId: string): Promise<boolean> {
    if (!shareId) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(notFoundPage());
      return true;
    }

    const share = await this.shareService.getShare(shareId);
    if (!share) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(notFoundPage());
      return true;
    }

    // Resolve host path
    let hostPath: string;
    try {
      hostPath = await this.resolveHostPath(share.filePath, share.workspaceId);
    } catch (err: any) {
      console.error('[HttpShareHandler] Path resolution error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not resolve file path' }));
      return true;
    }

    // Read file
    let content: string;
    try {
      content = await readFile(hostPath, 'utf-8');
    } catch (err: any) {
      console.error('[HttpShareHandler] File read error:', err.message, '| path:', hostPath);
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(notFoundPage());
      return true;
    }

    if (share.fileType === 'html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      });
      res.end(content);
    } else {
      // markdown → HTML
      const htmlBody = await marked(content);
      const fileName = share.filePath.split('/').pop() ?? 'Document';
      const page = markdownPage(fileName.replace(/\.(md|markdown)$/i, ''), htmlBody);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      });
      res.end(page);
    }

    return true;
  }

  // ── GET /api/share?filePath=...&workspaceId=... ───────────────────────────

  private async handleGetByFilePath(req: IncomingMessage, res: ServerResponse, parsedUrl: URL): Promise<boolean> {
    const userId = await this.getUserId(req);
    if (!userId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }

    const filePath = parsedUrl.searchParams.get('filePath');
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'filePath is required' }));
      return true;
    }

    // workspaceId is optional but recommended: disambiguates the lookup when
    // the same filePath exists in multiple workspaces owned by the same user.
    const workspaceId = parsedUrl.searchParams.get('workspaceId') ?? undefined;

    const doc = await this.shareService.getShareByFile(userId, filePath, workspaceId);
    if (!doc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not shared' }));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ shareId: doc.shareId, filePath: doc.filePath, createdAt: doc.createdAt }));
    return true;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async getUserId(req: IncomingMessage): Promise<string | null> {
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const result = await this.authService.validateSession(token);
      return result.success ? (result.user?.userId ?? null) : null;
    }
    const parsed = new URL(req.url || '', `http://${req.headers.host}`);
    const queryToken = parsed.searchParams.get('token');
    if (queryToken) {
      const result = await this.authService.validateSession(queryToken);
      return result.success ? (result.user?.userId ?? null) : null;
    }
    return null;
  }

  /**
   * Resolve the host-side path for a file stored in a workspace volume.
   * Uses workspaceId directly (we already have it from the share record).
   */
  private async resolveHostPath(filePath: string, workspaceId: string): Promise<string> {
    if (!this.workspaceService) {
      throw new Error('WorkspaceService not available');
    }

    const workspace = await this.workspaceService.getWorkspace(workspaceId);
    if (!workspace?.volumeId) throw new Error(`Workspace has no volume: ${workspaceId}`);

    const vol = await this.volumeService.getVolume(workspace.volumeId);
    if (!vol) throw new Error(`Volume not found: ${workspace.volumeId}`);

    const volumeHostPath = vol.hostPath;

    // Strip container mount prefix
    let relativePath = filePath;
    if (filePath.startsWith(CONTAINER_MOUNT + '/')) {
      relativePath = filePath.slice(CONTAINER_MOUNT.length + 1);
    } else if (filePath.startsWith(CONTAINER_MOUNT)) {
      relativePath = filePath.slice(CONTAINER_MOUNT.length);
    }

    if (relativePath.includes('..')) throw new Error('Invalid file path: path traversal detected');

    return join(volumeHostPath, relativePath);
  }
}
