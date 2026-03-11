import { readFile, stat } from 'fs/promises';
import { basename, extname } from 'path';

// Backend URL for media uploads — must be set via MCA_BACKEND_URL
const BACKEND_URL = process.env.MCA_BACKEND_URL;
if (!BACKEND_URL) throw new Error('MCA_BACKEND_URL environment variable is required');

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
};

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
  const response = await fetch(`${BACKEND_URL}/api/media/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
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

/**
 * Resolve URL - either use direct URL or upload local file
 */
export async function resolveUrl(
  url?: string,
  filePath?: string,
  filename?: string,
): Promise<{ url: string; mimeType?: string; size?: number }> {
  if (url) {
    // Direct URL - use as-is
    return { url };
  }

  if (filePath) {
    // Local file - upload to backend
    return await uploadLocalFile(filePath, filename);
  }

  throw new Error("Either 'url' or 'filePath' is required");
}

// Re-export basename for convenience
export { basename } from 'path';
