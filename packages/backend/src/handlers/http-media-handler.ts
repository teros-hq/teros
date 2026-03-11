/**
 * HTTP Media Handler
 *
 * Handles media file uploads and serving for the messaging system.
 * Allows agents to upload local files and serve them via URLs.
 *
 * Endpoints:
 * - POST /api/media/upload - Upload a file (multipart, base64, or file path)
 * - GET /media/:mediaId - Serve an uploaded file
 */

import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import { basename, dirname, extname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Media storage directory
const MEDIA_DIR = join(__dirname, '..', '..', 'media');

// Max file size (50MB for media)
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Allowed MIME types for media
const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/aac'],
  video: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'],
  document: [
    'application/pdf',
    'application/json',
    'text/plain',
    'text/csv',
    'text/html',
    'application/zip',
    'application/x-tar',
    'application/gzip',
  ],
};

// Extension to MIME type mapping
const EXT_TO_MIME: Record<string, string> = {
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  // Video
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  // Documents
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
};

// MIME type to extension mapping (for when we only have MIME type)
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/quicktime': '.mov',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/html': '.html',
  'application/zip': '.zip',
  'application/x-tar': '.tar',
  'application/gzip': '.gz',
};

interface MediaUploadResult {
  success: boolean;
  mediaId?: string;
  url?: string;
  mimeType?: string;
  size?: number;
  filename?: string;
  error?: string;
}

interface MediaMetadata {
  mediaId: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  channelId?: string;
  expiresAt?: string;
}

/**
 * Ensure media directory exists
 */
async function ensureMediaDir(): Promise<void> {
  if (!existsSync(MEDIA_DIR)) {
    await mkdir(MEDIA_DIR, { recursive: true });
    console.log(`[MediaHandler] Created media directory: ${MEDIA_DIR}`);
  }
}

/**
 * Get MIME type from file extension
 */
function getMimeType(filename: string): string | undefined {
  const ext = extname(filename).toLowerCase();
  return EXT_TO_MIME[ext];
}

/**
 * Get extension from MIME type
 */
function getExtension(mimeType: string): string {
  return MIME_TO_EXT[mimeType] || '';
}

/**
 * Check if MIME type is allowed
 */
function isAllowedMimeType(mimeType: string): boolean {
  return Object.values(ALLOWED_MIME_TYPES).flat().includes(mimeType);
}

/**
 * Parse JSON body from request
 */
async function parseJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString();
  return JSON.parse(body);
}

/**
 * Handle media upload via JSON (base64 or file path)
 */
async function handleJsonUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await parseJsonBody(req);

    let fileBuffer: Buffer;
    let filename: string;
    let mimeType: string;

    if (body.filePath) {
      // Upload from local file path
      const filePath = body.filePath;

      // Security: prevent path traversal
      if (filePath.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid file path' }));
        return;
      }

      // Check file exists
      try {
        const stats = await stat(filePath);
        if (stats.size > MAX_FILE_SIZE) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              error: `File too large. Max size: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
            }),
          );
          return;
        }
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'File not found' }));
        return;
      }

      fileBuffer = await readFile(filePath);
      filename = body.filename || basename(filePath);
      mimeType = body.mimeType || getMimeType(filename) || 'application/octet-stream';
    } else if (body.data) {
      // Upload from base64 data
      fileBuffer = Buffer.from(body.data, 'base64');

      if (fileBuffer.length > MAX_FILE_SIZE) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            success: false,
            error: `File too large. Max size: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
          }),
        );
        return;
      }

      mimeType = body.mimeType || 'application/octet-stream';
      const ext = getExtension(mimeType) || '.bin';
      filename = body.filename || `file${ext}`;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ success: false, error: 'Either filePath or data (base64) is required' }),
      );
      return;
    }

    // Validate MIME type
    if (!isAllowedMimeType(mimeType)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: `Unsupported file type: ${mimeType}`,
        }),
      );
      return;
    }

    // Generate media ID and save file
    await ensureMediaDir();
    const mediaId = randomUUID();
    const ext = extname(filename) || getExtension(mimeType) || '';
    const storedFilename = `${mediaId}${ext}`;
    const filePath = join(MEDIA_DIR, storedFilename);

    await writeFile(filePath, fileBuffer);

    // Save metadata
    const metadata: MediaMetadata = {
      mediaId,
      filename,
      mimeType,
      size: fileBuffer.length,
      uploadedAt: new Date().toISOString(),
      channelId: body.channelId,
    };
    await writeFile(join(MEDIA_DIR, `${mediaId}.json`), JSON.stringify(metadata, null, 2));

    // Build URL
    const baseUrl = config.static.baseUrl.replace('/static', '');
    const url = `${baseUrl}/media/${mediaId}`;

    console.log(
      `✅ Media uploaded: ${filename} -> ${mediaId} (${mimeType}, ${fileBuffer.length} bytes)`,
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        mediaId,
        url,
        mimeType,
        size: fileBuffer.length,
        filename,
      }),
    );
  } catch (error) {
    console.error('❌ Error uploading media:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      }),
    );
  }
}

/**
 * Serve a media file by ID
 */
async function handleMediaServe(res: ServerResponse, mediaId: string): Promise<void> {
  try {
    // Load metadata
    const metadataPath = join(MEDIA_DIR, `${mediaId}.json`);

    if (!existsSync(metadataPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Media not found' }));
      return;
    }

    const metadata: MediaMetadata = JSON.parse(await readFile(metadataPath, 'utf-8'));

    // Find the actual file (try common extensions)
    let filePath: string | null = null;
    const ext = getExtension(metadata.mimeType) || extname(metadata.filename);
    const possiblePath = join(MEDIA_DIR, `${mediaId}${ext}`);

    if (existsSync(possiblePath)) {
      filePath = possiblePath;
    } else {
      // Try without extension
      const noExtPath = join(MEDIA_DIR, mediaId);
      if (existsSync(noExtPath)) {
        filePath = noExtPath;
      }
    }

    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Media file not found' }));
      return;
    }

    const fileBuffer = await readFile(filePath);

    res.writeHead(200, {
      'Content-Type': metadata.mimeType,
      'Content-Length': fileBuffer.length.toString(),
      'Content-Disposition': `inline; filename="${metadata.filename}"`,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(fileBuffer);
  } catch (error) {
    console.error('❌ Error serving media:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

/**
 * HTTP Media Handler class
 */
export class HttpMediaHandler {
  /**
   * Handle media routes
   * Returns true if the route was handled
   */
  async handleRoute(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    const method = req.method || 'GET';

    // POST /api/media/upload - Upload media file
    if (url === '/api/media/upload' && method === 'POST') {
      await handleJsonUpload(req, res);
      return true;
    }

    // GET /media/:mediaId - Serve media file
    const mediaMatch = url.match(/^\/media\/([a-f0-9-]+)$/i);
    if (mediaMatch && method === 'GET') {
      const mediaId = mediaMatch[1];
      await handleMediaServe(res, mediaId);
      return true;
    }

    return false;
  }
}
