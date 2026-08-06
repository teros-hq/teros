/**
 * HTTP Upload Handler
 * Handles file uploads for avatars and other static assets
 */

import { createHash, randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from 'mongodb';
import { extname, join } from 'path';
import { config } from '../config';
import type { AuthService } from '../auth/auth-service';
import { staticDir, uploadDir } from '../lib/static-paths';

// ---------------------------------------------------------------------------
// Security constants
// ---------------------------------------------------------------------------

/**
 * MIME types allowed for generic static uploads (whitelist — prevents Stored XSS via
 * .html/.js/.svg uploads and limits attack surface to known-safe formats).
 */
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/x-icon',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  // Text / data
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/xml',
  // Archives
  'application/zip',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/vnd.rar',
  'application/x-7z-compressed',
  // Audio
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
  'audio/webm',
  'audio/flac',
  'audio/x-m4a',
  // Video
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/x-matroska',
  // Generic binary
  'application/octet-stream',
]);

/** MIME types allowed specifically for agent avatars (images only). */
const ALLOWED_AVATAR_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/**
 * Extension → canonical MIME type mapping used to cross-check the client-supplied
 * Content-Type against the actual file extension, preventing MIME-type spoofing
 * (e.g. uploading a .html file while claiming image/jpeg).
 *
 * This map is intentionally broader than the upload whitelists — it covers common
 * dangerous types (html, js, svg…) so they are correctly identified and rejected
 * by the downstream whitelist check, even when the client lies about the type.
 */
const EXT_TO_MIME: Record<string, string> = {
  // Allowed upload types
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  // Now-allowed types (previously listed as dangerous)
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/x-m4a',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  // Still-dangerous types — whitelist will reject them
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.sh': 'application/x-sh',
  '.php': 'application/x-httpd-php',
  '.py': 'text/x-python',
  '.rb': 'application/x-ruby',
};

/** Max file size for generic static uploads: 100 MB. */
const MAX_FILE_SIZE = 100 * 1024 * 1024;

/** Max file size for avatar uploads: 5 MB. */
const AVATAR_MAX_SIZE = 5 * 1024 * 1024;


// ---------------------------------------------------------------------------
// MIME type mapping for HTTP static-file serving (Content-Type response header)
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  // Text
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  // Archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  // Video
  '.mp4': 'video/mp4',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  // Other
  '.bin': 'application/octet-stream',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UploadedFile {
  fileId: string;
  url: string;
  originalName: string;
  mimeType: string;
  size: number;
}

interface ParsedFile {
  file: Buffer;
  filename: string;
  /** Resolved MIME type — cross-checked between header and extension. */
  mimeType: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the effective MIME type for an upload.
 *
 * Strategy (defence-in-depth):
 *   1. Derive the canonical MIME type from the file extension (ground truth).
 *   2. If the extension is known, the client-supplied Content-Type MUST match.
 *      A mismatch is a strong indicator of MIME-type spoofing.
 *   3. If the extension is unknown, fall back to the client-supplied type (or
 *      'application/octet-stream' as last resort).
 *
 * This prevents an attacker from uploading a .html file while claiming it is
 * image/jpeg, which would bypass the mime-type whitelist check.
 */
export function resolveMimeType(filename: string, clientMimeType: string): string {
  const ext = extname(filename).toLowerCase();
  const extMime = EXT_TO_MIME[ext];

  if (extMime) {
    // Known extension — the client type must agree.
    // If it disagrees (spoofing attempt), use the extension-derived type so
    // the downstream whitelist check will correctly reject or accept it.
    return extMime;
  }

  // Unknown extension — trust the client type (will be checked against whitelist).
  return clientMimeType || 'application/octet-stream';
}

/**
 * Parse multipart form data (simplified parser for single file upload).
 *
 * Security note: the body is read with a streaming size cap (`maxBytes`) to
 * prevent memory exhaustion from oversized uploads. If the incoming stream
 * exceeds `maxBytes`, parsing is aborted and `null` is returned.
 */
export async function parseMultipartFormData(
  req: IncomingMessage,
  maxBytes: number,
): Promise<ParsedFile | null> {
  const contentType = req.headers['content-type'] || '';

  if (!contentType.includes('multipart/form-data')) {
    return null;
  }

  // Extract boundary
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) {
    return null;
  }
  const boundary = boundaryMatch[1];

  // Read body with streaming size cap — abort if maxBytes exceeded.
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += (chunk as Buffer).length;
    if (totalBytes > maxBytes) {
      // Drain the rest of the stream to avoid leaving it in a broken state,
      // then signal the caller that the upload was too large.
      req.resume();
      return null;
    }
    chunks.push(chunk as Buffer);
  }

  const body = Buffer.concat(chunks);

  // Parse multipart data
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let start = 0;

  while (true) {
    const boundaryIndex = body.indexOf(boundaryBuffer, start);
    if (boundaryIndex === -1) break;

    if (start > 0) {
      parts.push(body.slice(start, boundaryIndex - 2)); // -2 for \r\n
    }
    start = boundaryIndex + boundaryBuffer.length + 2; // +2 for \r\n
  }

  // Find the file part
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;

    const headers = part.slice(0, headerEnd).toString();
    const content = part.slice(headerEnd + 4);

    // Check if this is a file
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

    if (filenameMatch) {
      const filename = filenameMatch[1];
      const clientMimeType = contentTypeMatch?.[1]?.trim() || 'application/octet-stream';

      // Resolve MIME type cross-checking extension vs client-supplied type.
      const mimeType = resolveMimeType(filename, clientMimeType);

      return { file: content, filename, mimeType };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * Handle avatar upload.
 * Validates: image MIME type only, 5 MB max size.
 */
async function handleAvatarUpload(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  agentId: string,
): Promise<void> {
  try {
    // Parse with the avatar-specific size cap (streaming guard).
    const fileData = await parseMultipartFormData(req, AVATAR_MAX_SIZE);

    if (!fileData) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: `No file uploaded, invalid format, or file exceeds the ${AVATAR_MAX_SIZE / 1024 / 1024} MB limit`,
        }),
      );
      return;
    }

    const { file, filename, mimeType } = fileData;

    // Validate MIME type (avatars must be images).
    if (!ALLOWED_AVATAR_MIME_TYPES.has(mimeType)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: `Invalid file type: ${mimeType}. Allowed types for avatars: ${[...ALLOWED_AVATAR_MIME_TYPES].join(', ')}`,
        }),
      );
      return;
    }

    // Double-check size after parsing (streaming cap already enforced above).
    if (file.length > AVATAR_MAX_SIZE) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: `File too large. Maximum size for avatars: ${AVATAR_MAX_SIZE / 1024 / 1024} MB`,
        }),
      );
      return;
    }

    // Generate unique filename. Sanitize the agentId — ids like "agent:iria"
    // contain ':' which the browser percent-encodes in the <img> URL (%3A),
    // producing a 404 on the static route. Mirror the chat upload sanitization.
    const ext = extname(filename) || '.jpg';
    const safeAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const newFilename = `${safeAgentId}-avatar-${randomUUID().slice(0, 8)}${ext}`;
    const filePath = join(staticDir, newFilename);

    // Ensure static directory exists
    await mkdir(staticDir, { recursive: true });

    // Write file
    await writeFile(filePath, file);

    // Public URL for immediate display in the upload response.
    const publicUrl = `${config.static.baseUrl}/${newFilename}`;

    // Persist the BARE filename — same convention as predefined core avatars
    // ("iria.png"). The various buildAvatarUrl() resolvers prepend the static
    // base, so storing an absolute URL here produced double-wrapping
    // (`<base>/<base>/<file>` → 404, broken avatar on reload).
    const agentsCollection = db.collection('agents');
    const result = await agentsCollection.updateOne(
      { agentId },
      { $set: { avatarUrl: newFilename, updatedAt: new Date().toISOString() } },
    );

    if (result.matchedCount === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Agent not found' }));
      return;
    }

    console.log(`✅ Avatar uploaded for agent ${agentId}: ${newFilename}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        filename: newFilename,
        url: publicUrl,
      }),
    );
  } catch (error) {
    console.error('❌ Error uploading avatar:', error);
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
 * Handle generic file upload to static directory.
 * Validates: ALLOWED_UPLOAD_MIME_TYPES whitelist, 100 MB max size.
 * Prevents Stored XSS via .html/.js/.svg uploads (C-5).
 */
async function handleStaticUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Parse with the global size cap (streaming guard).
    const fileData = await parseMultipartFormData(req, MAX_FILE_SIZE);

    if (!fileData) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: `No file uploaded, invalid format, or file exceeds the ${MAX_FILE_SIZE / 1024 / 1024} MB limit`,
        }),
      );
      return;
    }

    const { file, filename, mimeType } = fileData;

    // Validate MIME type against whitelist (prevents .html/.js/.svg XSS uploads).
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: `File type not allowed: ${mimeType}. Allowed types: ${[...ALLOWED_UPLOAD_MIME_TYPES].join(', ')}`,
        }),
      );
      return;
    }

    // Double-check size after parsing (streaming cap already enforced above).
    if (file.length > MAX_FILE_SIZE) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024} MB`,
        }),
      );
      return;
    }

    // Generate unique filename (keep sanitised original name + uuid suffix).
    const ext = extname(filename);
    const baseName = filename.replace(ext, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    // En modo test (TEROS_DETERMINISTIC) el sufijo se deriva del CONTENIDO del
    // archivo en vez de un UUID aleatorio: así el `[User sent a file: …](url)`
    // del mensaje es estable y el replay @llm hace match por hash. Robusto al
    // orden de subidas (sin estado). En producción: UUID aleatorio. TER-563.
    const fileId =
      process.env.TEROS_DETERMINISTIC === '1'
        ? createHash('sha256').update(`${baseName}:${file.length}`).digest('hex').slice(0, 12)
        : randomUUID();
    const newFilename = `${baseName}-${fileId}${ext}`;
    const filePath = join(uploadDir, newFilename);

    // Ensure upload directory exists
    await mkdir(uploadDir, { recursive: true });

    // Write file
    await writeFile(filePath, file);

    // Build URL
    const url = `${config.static.baseUrl}/uploads/${newFilename}`;

    console.log(
      `✅ File uploaded: ${newFilename} (${mimeType}, ${(file.length / 1024).toFixed(1)} KB)`,
    );

    // Return response in format expected by frontend
    const uploadedFile: UploadedFile = {
      fileId,
      url,
      originalName: filename,
      mimeType,
      size: file.length,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        file: uploadedFile,
        // Legacy fields for backwards compatibility
        filename: newFilename,
        url,
      }),
    );
  } catch (error) {
    console.error('❌ Error uploading file:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Handler class
// ---------------------------------------------------------------------------

export class HttpUploadHandler {
  constructor(private db: Db, private authService: AuthService) {}

  /**
   * Extract userId from Bearer token. Returns null if missing/invalid.
   */
  private async getUserId(req: IncomingMessage): Promise<string | null> {
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const result = await this.authService.validateSession(token);
      return result.success ? (result.user?.userId ?? null) : null;
    }
    return null;
  }

  /**
   * Handle upload routes.
   * Returns true if the route was handled.
   */
  async handleRoute(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    const method = req.method || 'GET';

    // POST /api/upload/avatar/:agentId — Upload agent avatar (requires auth)
    const avatarMatch = url.match(/^\/api\/upload\/avatar\/([^/]+)$/);
    if (avatarMatch && method === 'POST') {
      const userId = await this.getUserId(req);
      if (!userId) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Authentication required' }));
        return true;
      }
      const agentId = decodeURIComponent(avatarMatch[1]);
      await handleAvatarUpload(req, res, this.db, agentId);
      return true;
    }

    // POST /api/upload/static — Upload generic static file (requires auth)
    if (url === '/api/upload/static' && method === 'POST') {
      const userId = await this.getUserId(req);
      if (!userId) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Authentication required' }));
        return true;
      }
      await handleStaticUpload(req, res);
      return true;
    }

    return false;
  }
}

// Re-export MIME_TYPES for use by static file serving middleware
export { MIME_TYPES };
