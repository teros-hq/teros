/**
 * HTTP File Handler
 *
 * Serves workspace files for the HtmlFileBubble component.
 * Endpoint: GET /api/files?path=/workspace/foo.html&channelId=ch_xxx
 *
 * Auth: Bearer token in Authorization header (or ?token= query param).
 */

import { readFile } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import { join } from 'path';
import type { Db } from 'mongodb';
import type { AuthService } from '../auth/auth-service';
import type { VolumeService } from '../services/volume-service';
import type { WorkspaceService } from '../services/workspace-service';

const CONTAINER_MOUNT = '/workspace';

export class HttpFileHandler {
  constructor(
    private db: Db,
    private authService: AuthService,
    private volumeService: VolumeService,
    private workspaceService: WorkspaceService | null,
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
    const filePath = parsed.searchParams.get('path');
    const channelId = parsed.searchParams.get('channelId');

    console.log('[HttpFileHandler] GET /api/files — raw url:', url, '| path:', filePath, '| channelId:', channelId);

    if (!filePath || !channelId) {
      console.warn('[HttpFileHandler] Missing params — path:', filePath, 'channelId:', channelId);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required params: path, channelId' }));
      return true;
    }

    // Authenticate
    const userId = await this.getUserId(req);
    if (!userId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }

    // Resolve host path
    let hostPath: string;
    try {
      hostPath = await this.resolveHostPath(filePath, channelId);
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
    // Authorization: Bearer <token>
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const result = await this.authService.validateSession(token);
      return result.success ? (result.user?.userId ?? null) : null;
    }
    // ?token= query param (convenient fallback)
    const parsed = new URL(req.url || '', `http://${req.headers.host}`);
    const queryToken = parsed.searchParams.get('token');
    if (queryToken) {
      const result = await this.authService.validateSession(queryToken);
      return result.success ? (result.user?.userId ?? null) : null;
    }
    return null;
  }

  private async resolveHostPath(filePath: string, channelId: string): Promise<string> {
    console.log('[HttpFileHandler] resolveHostPath — channelId:', channelId, 'filePath:', filePath);

    // Fast path: /workspace/... always maps to the MCA shared volume on the host.
    // This is a fixed mount — no need to look up channel/workspace/user volumes.
    const HOST_SHARED_WORKSPACE = '/workspace';
    if (filePath.startsWith(CONTAINER_MOUNT + '/') || filePath === CONTAINER_MOUNT) {
      const relativePath = filePath.slice(CONTAINER_MOUNT.length).replace(/^\//, '');
      if (relativePath.includes('..')) throw new Error('Invalid file path: path traversal detected');
      return join(HOST_SHARED_WORKSPACE, relativePath);
    }

    const channelsCol = this.db.collection<any>('channels');
    const channel = await channelsCol.findOne({ channelId });
    if (!channel) throw new Error(`Channel not found: ${channelId}`);

    console.log('[HttpFileHandler] channel.userId:', channel.userId, 'channel.workspaceId:', channel.workspaceId);

    let volumeHostPath: string | undefined;

    if (channel.workspaceId && this.workspaceService) {
      const workspace = await this.workspaceService.getWorkspace(channel.workspaceId);
      console.log('[HttpFileHandler] workspace:', workspace?.workspaceId, 'volumeId:', workspace?.volumeId);
      if (!workspace?.volumeId) throw new Error(`Workspace has no volume: ${channel.workspaceId}`);
      const vol = await this.volumeService.getVolume(workspace.volumeId);
      if (!vol) throw new Error(`Volume not found: ${workspace.volumeId}`);
      volumeHostPath = vol.hostPath;
    } else {
      console.log('[HttpFileHandler] getUserVolume — userId:', channel.userId);
      const vol = await this.volumeService.getUserVolume(channel.userId);
      console.log('[HttpFileHandler] getUserVolume result:', vol ? vol.volumeId : 'null/undefined');
      if (!vol) throw new Error(`Volume not found for user: ${channel.userId}`);
      volumeHostPath = vol.hostPath;
    }

    console.log('[HttpFileHandler] volumeHostPath:', volumeHostPath);

    if (!volumeHostPath) {
      throw new Error(`Cannot resolve volume host path for channel: ${channelId}`);
    }

    // Strip the container-side mount prefix and join with host path
    let relativePath = filePath;
    if (filePath.startsWith(CONTAINER_MOUNT + '/')) {
      relativePath = filePath.slice(CONTAINER_MOUNT.length + 1);
    } else if (filePath.startsWith(CONTAINER_MOUNT)) {
      relativePath = filePath.slice(CONTAINER_MOUNT.length);
    }

    // Prevent path traversal
    if (relativePath.includes('..')) throw new Error('Invalid file path: path traversal detected');

    console.log('[HttpFileHandler] relativePath:', relativePath, '→ final:', join(volumeHostPath, relativePath));

    return join(volumeHostPath, relativePath);
  }
}
