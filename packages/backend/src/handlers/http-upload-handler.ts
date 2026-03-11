/**
 * HTTP Upload Handler
 * Handles file uploads for avatars and other static assets
 */

import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from 'mongodb';
import { dirname, extname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Max file size (100MB)
const MAX_FILE_SIZE = 100 * 1024 * 1024;

// Static directory
const staticDir = join(__dirname, '..', '..', 'static');

// MIME type mapping for common extensions
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

interface UploadedFile {
  fileId: string;
  url: string;
  originalName: string;
  mimeType: string;
  size: number;
}

/**
 * Parse multipart form data (simplified parser for single file upload)
 */
async function parseMultipartFormData(
  req: IncomingMessage,
): Promise<{ file: Buffer; filename: string; mimeType: string } | null> {
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

  // Read full body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  // Parse multipart data
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = [];
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
      // Use provided content-type or infer from extension
      let mimeType = contentTypeMatch?.[1]?.trim() || 'application/octet-stream';

      // If mime type is generic, try to infer from extension
      if (mimeType === 'application/octet-stream') {
        const ext = extname(filename).toLowerCase();
        mimeType = MIME_TYPES[ext] || 'application/octet-stream';
      }

      return {
        file: content,
        filename,
        mimeType,
      };
    }
  }

  return null;
}

/**
 * Handle avatar upload
 */
async function handleAvatarUpload(
  req: IncomingMessage,
  res: ServerResponse,
  db: Db,
  agentId: string,
): Promise<void> {
  // Allowed image MIME types for avatars
  const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

  try {
    // Parse the multipart form data
    const fileData = await parseMultipartFormData(req);

    if (!fileData) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'No file uploaded or invalid format' }));
      return;
    }

    const { file, filename, mimeType } = fileData;

    // Validate MIME type (avatars must be images)
    if (!ALLOWED_AVATAR_TYPES.includes(mimeType)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: `Invalid file type: ${mimeType}. Allowed: ${ALLOWED_AVATAR_TYPES.join(', ')}`,
        }),
      );
      return;
    }

    // Validate file size (5MB for avatars)
    const AVATAR_MAX_SIZE = 5 * 1024 * 1024;
    if (file.length > AVATAR_MAX_SIZE) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: `File too large. Max size for avatars: ${AVATAR_MAX_SIZE / 1024 / 1024}MB`,
        }),
      );
      return;
    }

    // Generate unique filename
    const ext = extname(filename) || '.jpg';
    const newFilename = `${agentId}-avatar-${randomUUID().slice(0, 8)}${ext}`;
    const filePath = join(staticDir, newFilename);

    // Ensure static directory exists
    await mkdir(staticDir, { recursive: true });

    // Write file
    await writeFile(filePath, file);

    // Build URL
    const avatarUrl = `${config.static.baseUrl}/${newFilename}`;

    // Update agent in database
    const agentsCollection = db.collection('agents');
    const result = await agentsCollection.updateOne(
      { agentId },
      { $set: { avatarUrl, updatedAt: new Date().toISOString() } },
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
        url: avatarUrl,
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
 * Handle generic file upload to static directory
 * Supports any file type up to MAX_FILE_SIZE
 */
async function handleStaticUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Parse the multipart form data
    const fileData = await parseMultipartFormData(req);

    if (!fileData) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'No file uploaded or invalid format' }));
      return;
    }

    const { file, filename, mimeType } = fileData;

    // Validate file size
    if (file.length > MAX_FILE_SIZE) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          error: `File too large. Max size: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        }),
      );
      return;
    }

    // Generate unique filename (keep original name but add uuid)
    const ext = extname(filename);
    const fileId = randomUUID().slice(0, 12);
    const baseName = filename.replace(ext, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const newFilename = `${baseName}-${fileId}${ext}`;
    const filePath = join(staticDir, newFilename);

    // Ensure static directory exists
    await mkdir(staticDir, { recursive: true });

    // Write file
    await writeFile(filePath, file);

    // Build URL
    const url = `${config.static.baseUrl}/${newFilename}`;

    console.log(
      `✅ File uploaded: ${newFilename} (${mimeType}, ${(file.length / 1024).toFixed(1)}KB)`,
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
        // Also include legacy fields for backwards compatibility
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

export class HttpUploadHandler {
  constructor(private db: Db) {}

  /**
   * Handle upload routes
   * Returns true if the route was handled
   */
  async handleRoute(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    const method = req.method || 'GET';

    // POST /api/upload/avatar/:agentId - Upload agent avatar
    const avatarMatch = url.match(/^\/api\/upload\/avatar\/([^/]+)$/);
    if (avatarMatch && method === 'POST') {
      const agentId = decodeURIComponent(avatarMatch[1]);
      await handleAvatarUpload(req, res, this.db, agentId);
      return true;
    }

    // POST /api/upload/static - Upload generic static file
    if (url === '/api/upload/static' && method === 'POST') {
      await handleStaticUpload(req, res);
      return true;
    }

    return false;
  }
}
