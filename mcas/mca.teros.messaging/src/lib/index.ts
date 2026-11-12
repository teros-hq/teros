import { readFile, stat } from 'fs/promises';
import { basename, extname } from 'path';

// Backend URL for media uploads (from environment or default)
const BACKEND_URL = process.env.MCA_BACKEND_URL || 'https://be.teros.ai';

// Extension to MIME type mapping — shared by uploadLocalFile and send-file
export const EXT_TO_MIME: Record<string, string> = {
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
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.zip': 'application/zip',
};

/**
 * Infer the MIME type from a filename's extension (FVU-REQ-1).
 * Falls back to application/octet-stream for unknown extensions.
 */
export function extToMime(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return EXT_TO_MIME[ext] || 'application/octet-stream';
}

/**
 * Upload a local file to the backend and return the URL
 * Reads the file and sends it as base64 data (works across machines)
 */
export async function uploadLocalFile(
  filePath: string,
  filename?: string,
): Promise<{ url: string; mimeType: string; size: number }> {
  // Read file from local filesystem (inside container)
  const fileBuffer = await readFile(filePath);
  const stats = await stat(filePath);
  const actualFilename = filename || basename(filePath);
  const ext = extname(actualFilename).toLowerCase();
  const mimeType = EXT_TO_MIME[ext] || 'application/octet-stream';

  // Convert to base64 for transport
  const base64Data = fileBuffer.toString('base64');

  // Upload to backend as base64 data
  // Include MCA_CALLBACK_TOKEN for authentication (MCAs don't have user session tokens)
  const callbackToken = process.env.MCA_CALLBACK_TOKEN;
  const response = await fetch(`${BACKEND_URL}/api/media/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(callbackToken && { Authorization: `Bearer ${callbackToken}` }),
    },
    body: JSON.stringify({
      data: base64Data,
      filename: actualFilename,
      mimeType,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to upload file: ${error}`);
  }

  const result = await response.json();

  if (!result.success) {
    throw new Error(result.error || 'Upload failed');
  }

  return {
    url: result.url,
    mimeType: result.mimeType,
    size: stats.size,
  };
}

// -----------------------------------------------------------------------------
// Objects-system support (WS1c — 2026-10-20)
// -----------------------------------------------------------------------------

/**
 * Regex matching an objectId (`obj_<alphanumeric>`).
 */
const OBJECT_ID_RE = /^obj_[A-Za-z0-9]+$/;

/**
 * Regex matching a public objects URL on any backend host
 * (e.g. `https://be.teros.ai/objects/obj_abc123`,
 *       `http://localhost:10001/objects/obj_abc123`).
 */
const OBJECT_URL_RE = /\/objects\/(obj_[A-Za-z0-9]+)(?:[/?#]|$)/;

/**
 * Return true if the value looks like an objectId (`obj_...`).
 */
export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID_RE.test(value);
}

/**
 * Return true if the value looks like an objects-system public URL.
 */
export function isObjectUrl(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_URL_RE.test(value);
}

/**
 * Build the public URL for an objectId on the current backend.
 */
export function objectUrlFor(objectId: string): string {
  return `${BACKEND_URL}/objects/${objectId}`;
}

/**
 * Resolve URL — accepts:
 *   - public URLs (http/https) — returned as-is
 *   - objects-system URLs (.../objects/obj_...) — returned as-is
 *   - bare objectIds (`obj_...`) — expanded to the public objects URL
 *   - local file paths — uploaded to the backend via /api/media/upload
 *
 * Compatibility: previous behavior (URL pass-through, filePath upload) is
 * preserved. The new objectId / objects-URL branches simply skip the upload.
 */
export async function resolveUrl(
  url?: string,
  filePath?: string,
  filename?: string,
): Promise<{ url: string; mimeType?: string; size?: number }> {
  if (url) {
    // Bare objectId → expand to public objects URL
    if (isObjectId(url)) {
      return { url: objectUrlFor(url) };
    }
    // Direct URL (public or objects-system) — use as-is
    return { url };
  }

  if (filePath) {
    // Allow passing an objectId via filePath too (common agent mistake)
    if (isObjectId(filePath)) {
      return { url: objectUrlFor(filePath) };
    }
    // Local file - upload to backend
    return await uploadLocalFile(filePath, filename);
  }

  throw new Error("Either 'url' or 'filePath' is required");
}

// Re-export basename for convenience
export { basename, extname } from 'path';

// Share bridge (WS domain_request to backend share.* actions)
export { initializeWsClient, callShareBackend, isWsConnected } from './share-bridge';
