/**
 * Image resizing utilities using Sharp
 *
 * Provides on-the-fly image resizing with caching for static assets.
 * Supports query params: ?w=200&h=200&fit=cover&format=webp&q=80
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Cache directory for resized images */
const CACHE_DIR = join(__dirname, '..', '..', 'cache', 'images');

/** Max dimensions to prevent abuse */
const MAX_DIMENSION = 4096;

/** Supported output formats */
const SUPPORTED_FORMATS = ['jpeg', 'jpg', 'png', 'webp', 'avif', 'gif'] as const;
type OutputFormat = typeof SUPPORTED_FORMATS[number];

/** Fit modes */
type FitMode = 'cover' | 'contain' | 'fill' | 'inside' | 'outside';

export interface ResizeOptions {
  width?: number;
  height?: number;
  fit?: FitMode;
  format?: OutputFormat;
  quality?: number;
}

export interface ResizeResult {
  data: Buffer;
  contentType: string;
  cached: boolean;
}

/**
 * Parse resize options from URL query params
 */
export function parseResizeOptions(url: URL): ResizeOptions | null {
  const w = url.searchParams.get('w');
  const h = url.searchParams.get('h');
  const fit = url.searchParams.get('fit') as FitMode | null;
  const format = url.searchParams.get('format') as OutputFormat | null;
  const q = url.searchParams.get('q');

  // No resize params = no resize
  if (!w && !h && !format) return null;

  const width = w ? parseInt(w, 10) : undefined;
  const height = h ? parseInt(h, 10) : undefined;
  const quality = q ? parseInt(q, 10) : 80;

  // Validate dimensions
  if (width && (isNaN(width) || width < 1 || width > MAX_DIMENSION)) return null;
  if (height && (isNaN(height) || height < 1 || height > MAX_DIMENSION)) return null;
  if (isNaN(quality) || quality < 1 || quality > 100) return null;

  // Validate format
  if (format && !SUPPORTED_FORMATS.includes(format)) return null;

  // Validate fit
  const validFits: FitMode[] = ['cover', 'contain', 'fill', 'inside', 'outside'];
  if (fit && !validFits.includes(fit)) return null;

  return { width, height, fit: fit || 'cover', format: format ?? undefined, quality };
}

/**
 * Generate cache key from file path and resize options
 */
function getCacheKey(filePath: string, options: ResizeOptions): string {
  const hash = createHash('sha256');
  hash.update(filePath);
  hash.update(JSON.stringify(options));
  return hash.digest('hex').slice(0, 32);
}

/**
 * Get cached resized image if exists
 */
async function getCached(cacheKey: string): Promise<Buffer | null> {
  try {
    const cachePath = join(CACHE_DIR, cacheKey);
    return await fs.readFile(cachePath);
  } catch {
    return null;
  }
}

/**
 * Save resized image to cache
 */
async function saveToCache(cacheKey: string, data: Buffer): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const cachePath = join(CACHE_DIR, cacheKey);
    await fs.writeFile(cachePath, data);
  } catch (error) {
    // Cache write failure is non-fatal
    console.warn('[image-resize] Failed to write cache:', error);
  }
}

/**
 * Check if a file is an image that can be resized
 */
export function isResizableImage(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.tiff', '.svg'].includes(ext);
}

/**
 * Resize an image with Sharp
 */
export async function resizeImage(
  filePath: string,
  options: ResizeOptions,
): Promise<ResizeResult> {
  const cacheKey = getCacheKey(filePath, options);

  // Check cache first
  const cached = await getCached(cacheKey);
  if (cached) {
    const format = options.format || extname(filePath).slice(1) as OutputFormat;
    return {
      data: cached,
      contentType: `image/${format === 'jpg' ? 'jpeg' : format}`,
      cached: true,
    };
  }

  // Read original
  const inputBuffer = await fs.readFile(filePath);

  // Build Sharp pipeline
  let pipeline = sharp(inputBuffer);

  // Apply resize if dimensions specified
  if (options.width || options.height) {
    pipeline = pipeline.resize(options.width, options.height, {
      fit: options.fit || 'cover',
      withoutEnlargement: true, // Don't upscale small images
    });
  }

  // Apply format conversion if specified
  if (options.format) {
    switch (options.format) {
      case 'jpeg':
      case 'jpg':
        pipeline = pipeline.jpeg({ quality: options.quality });
        break;
      case 'png':
        pipeline = pipeline.png({ quality: options.quality });
        break;
      case 'webp':
        pipeline = pipeline.webp({ quality: options.quality });
        break;
      case 'avif':
        pipeline = pipeline.avif({ quality: options.quality });
        break;
      case 'gif':
        pipeline = pipeline.gif();
        break;
    }
  }

  // Execute
  const data = await pipeline.toBuffer();

  // Determine content type
  const outputFormat = options.format || extname(filePath).slice(1) as OutputFormat;
  const contentType = `image/${outputFormat === 'jpg' ? 'jpeg' : outputFormat}`;

  // Save to cache (async, don't wait)
  saveToCache(cacheKey, data).catch(() => {});

  return { data, contentType, cached: false };
}

/**
 * Clear the image cache (for maintenance)
 */
export async function clearImageCache(): Promise<number> {
  try {
    const files = await fs.readdir(CACHE_DIR);
    let count = 0;
    for (const file of files) {
      await fs.unlink(join(CACHE_DIR, file));
      count++;
    }
    return count;
  } catch {
    return 0;
  }
}
