/**
 * HTTP File Handler
 *
 * Serves workspace files for the HtmlFileBubble component.
 * Endpoint: GET /api/files?path=/workspace/foo.html&channelId=ch_xxx
 *
 * Auth: Bearer token in Authorization header only.
 */

import { readFile } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from 'mongodb';
import type { AuthService } from '../auth/auth-service';
import type { ChannelManager } from '../services/channel-manager';
import type { VolumeService } from '../services/volume-service';
import type { WorkspaceService } from '../services/workspace-service';
import { resolveVolumeHostPath } from '../lib/volume-path-resolver';

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

    console.log('[HttpFileHandler] GET /api/files — raw url:', url, '| path:', filePath, '| workspaceId:', workspaceId, '| channelId:', channelId);

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

    // Read file
    try {
      const content = await readFile(hostPath, 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(content);
    } catch (err: any) {
      console.error('[HttpFileHandler] Read error:', err.message);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
    }

    return true;
  }

  private async getUserId(req: IncomingMessage): Promise<string | null> {
    // Authorization: Bearer <token> (only accepted auth method)
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const result = await this.authService.validateSession(token);
      return result.success ? (result.user?.userId ?? null) : null;
    }
    return null;
  }

}
