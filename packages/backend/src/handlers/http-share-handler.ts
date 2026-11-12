/**
 * HTTP Share Handler — PUBLIC serving only
 *
 * Serves shared files at their public links:
 *   GET /share/:shareId — serve shared file (public, no auth)
 * A `todo-io` share (TODOOV-REQ-4) serves a To Do task's current output or
 * input instead of a volume file.
 *
 * This is NOT an API endpoint — it IS the public link itself (a browser or
 * WhatsApp must be able to open it). All share management (create/get/revoke)
 * moved to the WebSocket `share` domain (handlers/domains/share) per the
 * platform's WS-first architecture rule; the old REST /api/share endpoints
 * were removed 2026-10-21.
 *
 * CACHE POLICY (security finding F5, 2026-11-02, review tn_KjOnSKdgygs1xbQu):
 * /share/:id is a REVOCABLE public link, so its responses are never cached
 * long. Successful serves: `public, max-age=60` (volume shares — a
 * revocation reaches any browser within 60s) or `no-store` (todo-io shares,
 * whose content changes with every delivery). Every 4xx/5xx — including the
 * 404 a revoked share must answer — carries `no-store`, so no browser or
 * shared proxy can mask or delay a revocation. The 1-year `immutable` cache
 * belongs ONLY to /objects/:objectId (capability URL — see
 * routes/agent-apps-storage-routes.ts). Trade-off accepted: short cache
 * means each share view re-hits the server; that cost buys real revocation.
 *
 * INLINE CONTENT CONTAINMENT (security finding F1, 2026-11-02, same review):
 * browser-executable share content (volume .html/.svg/.xml/.js files) is
 * served inline DELIBERATELY (it is the deliverable) — contained by a CSP
 * `sandbox allow-scripts` + `frame-ancestors` header instead of a download:
 * opaque origin, scripts run, Teros cookies/storage/same-origin fetch are
 * unreachable. Every response (any type, any status) carries nosniff. Our
 * own generated pages (rendered markdown, the 404 page) get nosniff only.
 * See lib/content-safety.ts (applyInlineSafetyHeaders).
 */

import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from 'mongodb';
import { renderMarkdown as renderSharedMarkdown } from '@teros/shared/markdown';
import type { VolumeService } from '../services/volume-service';
import type { WorkspaceService } from '../services/workspace-service';
import type { ShareService, TodoIoShare } from '../services/share-service';
import { resolveIoShareContent } from './domains/todo-share';
import { applyInlineSafetyHeaders, buildFrameAncestorsDirective } from '../lib/content-safety';
import { config as globalConfig } from '../config';

const CONTAINER_MOUNT = '/workspace';

// Extension -> MIME map for serving 'file' shares (FVU).
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.pdf': 'application/pdf', '.json': 'application/json', '.txt': 'text/plain',
  '.csv': 'text/csv', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml', '.js': 'text/javascript',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
};

function extToMime(filePath: string): string {
  return EXT_TO_MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

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
    .md-check { margin-right: 0.35em; }
  </style>
</head>
<body>
  <div class="container">
    ${body}
  </div>
</body>
</html>`;
}

// Markdown → HTML body through the platform policy (@teros/shared/markdown, MD-UNIFY v2):
// `~` literal (MD-STRIKE-1), raw HTML stripped, unsafe URLs dropped.
async function renderMarkdown(content: string): Promise<string> {
  return renderSharedMarkdown(content);
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class HttpShareHandler {
  /**
   * F1 containment: frame-ancestors directive for inline-served
   * browser-executable share content (volume .html/.svg/.xml/.js files).
   * Derived from the CORS allowlist so our own app origins (the FVU embeds,
   * the app viewer) keep working while third parties cannot embed. See
   * buildFrameAncestorsDirective for why 'self' alone would break the embeds.
   */
  private readonly frameAncestors: string;

  constructor(
    private db: Db,
    private volumeService: VolumeService,
    private workspaceService: WorkspaceService | null,
    private shareService: ShareService,
    corsAllowedOrigins: readonly string[] = globalConfig.security.corsAllowedOrigins,
  ) {
    this.frameAncestors = buildFrameAncestorsDirective(corsAllowedOrigins);
  }

  async handleRoute(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    const method = req.method || 'GET';
    const parsedUrl = new URL(url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // GET /share/:shareId — serve file (public, no auth — this IS the link)
    if (pathname.startsWith('/share/') && method === 'GET') {
      const shareId = pathname.slice('/share/'.length);
      return this.handleServe(req, res, shareId);
    }

    return false;
  }

  // ── GET /share/:shareId ────────────────────────────────────────────────────

  private async handleServe(req: IncomingMessage, res: ServerResponse, shareId: string): Promise<boolean> {
    if (!shareId) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(notFoundPage());
      return true;
    }

    const share = await this.shareService.getShare(shareId);
    if (!share) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(notFoundPage());
      return true;
    }

    if (share.source) {
      return this.serveTodoIo(res, share);
    }

    // Resolve host path
    let hostPath: string;
    try {
      hostPath = await this.resolveHostPath(share.filePath, share.workspaceId);
    } catch (err: any) {
      console.error('[HttpShareHandler] Path resolution error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify({ error: 'Could not resolve file path' }));
      return true;
    }

    // Read file
    let content: string;
    try {
      content = await readFile(hostPath, 'utf-8');
    } catch (err: any) {
      console.error('[HttpShareHandler] File read error:', err.message, '| path:', hostPath);
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(notFoundPage());
      return true;
    }

    if (share.fileType === 'file') {
      // FVU: any other file type - serve with its real mimetype so the
      // browser renders/downloads it correctly (images inline, PDF viewer,
      // audio/video players, unknown types as download).
      // F1 containment: browser-executable types (html/svg/xml/js via
      // extToMime) get the CSP sandbox + frame-ancestors; every type gets
      // nosniff. See applyInlineSafetyHeaders.
      const mime = extToMime(share.filePath);
      const inlineTypes = /^(text\/|image\/|audio\/|video\/|application\/(pdf|json|xml|javascript))/;
      const disposition = inlineTypes.test(mime) ? 'inline' : 'attachment';
      const buf = await readFile(hostPath);
      const headers = applyInlineSafetyHeaders(
        {
          'Content-Type': mime,
          'Content-Disposition': disposition + '; filename="' + (share.filePath.split('/').pop() ?? 'file') + '"',
          'Cache-Control': 'public, max-age=60',
        },
        mime,
        this.frameAncestors,
      );
      res.writeHead(200, headers);
      res.end(buf);
      return true;
    }

    if (share.fileType === 'html') {
      // Raw volume HTML served inline — browser-executable by definition, so
      // the F1 CSP sandbox always applies (opaque origin: scripts run, Teros
      // cookies/storage/fetch are unreachable).
      const headers = applyInlineSafetyHeaders(
        {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=60',
        },
        'text/html',
        this.frameAncestors,
      );
      res.writeHead(200, headers);
      res.end(content);
    } else {
      // markdown → HTML. Our OWN generated page (markdown is sanitized by
      // renderMarkdown — raw HTML stripped), not user-executable content:
      // nosniff only, no CSP sandbox needed.
      const htmlBody = await renderMarkdown(content);
      const fileName = share.filePath.split('/').pop() ?? 'Document';
      const page = markdownPage(fileName.replace(/\.(md|markdown)$/i, ''), htmlBody);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(page);
    }

    return true;
  }

  /**
   * A To Do task's io (TODOOV-REQ-4): the CURRENT io, read at request time
   * (one node read, scoped to the share's workspace). Markdown → the shared
   * markdown page titled with the task text; a file → 302 to its object URL;
   * a form or a missing node/io → the 404 page. Not cached: the next request
   * after a new delivery serves it.
   * @spec TODOOV-REQ-4
   * @spec TODOOV-NFR-1
   */
  private async serveTodoIo(res: ServerResponse, share: TodoIoShare): Promise<boolean> {
    const content = await resolveIoShareContent(this.db, share);
    if (!content) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(notFoundPage());
      return true;
    }
    if (content.kind === 'file') {
      res.writeHead(302, { Location: content.url, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end();
      return true;
    }
    const page = markdownPage(content.title, await renderMarkdown(content.markdown));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(page);
    return true;
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
