/**
 * Base processor utilities
 */

import { extname } from 'path';
import { type FileType, SUPPORTED_EXTENSIONS } from '../types.js';

/**
 * Detect file type based on extension
 */
export function detectFileType(filePath: string): FileType | null {
  const ext = getExtension(filePath);

  for (const [type, extensions] of Object.entries(SUPPORTED_EXTENSIONS)) {
    if ((extensions as readonly string[]).includes(ext)) {
      return type as FileType;
    }
  }

  return null;
}

/**
 * Normalized lowercase file extension without the leading dot (e.g. "docx").
 */
export function getExtension(filePath: string): string {
  return extname(filePath).toLowerCase().replace('.', '');
}

/**
 * Get media type for Claude API
 */
export function getMediaType(extension: string): string {
  const ext = extension.toLowerCase().replace('.', '');
  const mediaTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
  };

  return mediaTypes[ext] || 'application/octet-stream';
}
