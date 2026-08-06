/**
 * ImagePipeline - Downloads, resizes, and converts images to base64 for LLM providers
 *
 * Handles provider-agnostic image processing:
 * - Download from public URL
 * - Validate and resize to provider limits
 * - Convert to base64
 * - LRU cache with TTL to avoid re-downloading
 *
 * ## Vision Model Detection
 *
 * By default, ImagePipeline uses a built-in list of known vision-capable model name
 * substrings (e.g. 'claude-3', 'gpt-4o', 'gemini-2'). This list can be overridden
 * without changing code via:
 *
 *   TEROS_VISION_MODEL_PATTERNS="model-a,model-b"   (env var, comma-separated)
 *
 * Or per-instance via constructor options:
 *
 *   new ImagePipeline({ visionPatterns: ['my-custom-vision-model'] })
 *
 * Patterns are matched case-insensitively as substrings against the model string.
 */

import fs from 'fs/promises';
import { posix as pathPosix } from 'path';
import sharp from 'sharp';
import { log } from '../logger';
import type { FilePart } from '../session/types';

/** Canonical workspace mount root. Local file URLs must resolve inside it. */
const WORKSPACE_ROOT = '/workspace';

/**
 * True iff `url` is a `/workspace/...` path that, once normalised, stays
 * inside the workspace root — i.e. no `..` traversal escapes the mount.
 * `pathPosix.normalize` collapses `..`/`.`; we then require the result to be
 * `/workspace` itself or a child (`/workspace/<...>`), never `/workspace/../x`.
 */
function isInsideWorkspace(url: string): boolean {
  const normalised = pathPosix.normalize(url);
  return normalised === WORKSPACE_ROOT || normalised.startsWith(`${WORKSPACE_ROOT}/`);
}

export interface ProcessedImage {
  /** Base64 data without data: prefix */
  base64: string;
  /** MIME type of the processed image */
  mimeType: string;
  /** Width in pixels (after resize) */
  width?: number;
  /** Height in pixels (after resize) */
  height?: number;
  /** Size in bytes of the base64 string */
  sizeBytes: number;
}

interface CacheEntry {
  image: ProcessedImage;
  timestamp: number;
}

/** Provider-specific image limits */
const PROVIDER_LIMITS: Record<string, { maxSizeBytes: number; maxDimension: number; formats: string[]; maxImagesPerRequest?: number }> = {
  anthropic: {
    maxSizeBytes: 5 * 1024 * 1024, // ~5MB
    maxDimension: 4096,
    formats: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
    maxImagesPerRequest: 20,
  },
  openai: {
    maxSizeBytes: 20 * 1024 * 1024, // ~20MB
    maxDimension: 4096,
    formats: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  },
  gemini: {
    maxSizeBytes: 20 * 1024 * 1024, // ~20MB
    maxDimension: 4096,
    formats: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'],
  },
};

/** Default limits when provider is unknown */
const DEFAULT_LIMITS = PROVIDER_LIMITS.openai;

/** Cache TTL in milliseconds (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum cache size in bytes (50MB) */
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Allowed domains for image URL validation.
 *
 * Resolution order:
 *  1. TEROS_FILE_DOMAIN (comma-separated) — explicit allowlist.
 *  2. TEROS_UPLOAD_DOMAIN — legacy alias.
 *  3. Hostname of STATIC_BASE_URL — safe default: the backend already trusts
 *     this origin to serve uploads, so any URL hosted there is by definition
 *     a legitimate upload from this Teros instance.
 *  4. null — fail-closed (reject all remote URLs).
 *
 * Set TEROS_FILE_DOMAIN explicitly when uploads live on a different origin
 * than the static server (e.g. a CDN or separate file service).
 */
export function getDefaultAllowedDomains(): string[] | null {
  const envDomains = process.env.TEROS_FILE_DOMAIN || process.env.TEROS_UPLOAD_DOMAIN;
  if (envDomains) {
    return envDomains.split(',').map((d) => d.trim()).filter(Boolean);
  }
  const staticBaseUrl = process.env.STATIC_BASE_URL;
  if (staticBaseUrl) {
    try {
      const hostname = new URL(staticBaseUrl).hostname;
      if (hostname) {
        log.info(
          'ImagePipeline',
          `Auto-derived allowed image domain from STATIC_BASE_URL: ${hostname}. Set TEROS_FILE_DOMAIN to override.`,
        );
        return [hostname];
      }
    } catch {
      log.warn(
        'ImagePipeline',
        `STATIC_BASE_URL is malformed (${staticBaseUrl}); cannot derive allowed domain`,
      );
    }
  }
  return null;
}

/** Maximum download size (100MB) */
const MAX_DOWNLOAD_SIZE_BYTES = 100 * 1024 * 1024;

/** Download timeout in milliseconds (30 seconds) */
const DOWNLOAD_TIMEOUT_MS = 30 * 1000;

/** Max HTTP redirects to follow during a download (each hop re-validated). */
const MAX_DOWNLOAD_REDIRECTS = 5;

/**
 * ImagePipeline - processes images for LLM providers
 *
 * Features:
 * - Downloads images from URLs
 * - Resizes to provider-specific limits
 * - Converts to base64
 * - LRU cache with 5-minute TTL
 * - Graceful error handling (logs warning, skips image)
 */
/** Default vision-capable model name patterns (case-insensitive substring match) */
const DEFAULT_VISION_PATTERNS = [
  // Anthropic
  'claude-3', 'claude-4',
  // OpenAI
  'gpt-4o', 'gpt-4.1', 'gpt-5',
  'o3', 'o4',
  // Google
  'gemini-2', 'gemini-1.5',
  // Moonshot / Kimi (Fireworks AI hosting)
  'kimi-k2', 'kimi-vl',
  // Mistral
  'pixtral',
  // Meta
  'llama-3.2-vision', 'llama-4',
  // Alibaba
  'qwen2-vl', 'qwen2.5-vl', 'qwen-vl',
  // Zhipu
  'glm-4v',
  // Generic
  'llava', 'vision',
];

/**
 * Parse vision model patterns from environment variable.
 * TEROS_VISION_MODEL_PATTERNS: comma-separated substring patterns.
 * If set, overrides the built-in defaults entirely.
 */
function getEnvVisionPatterns(): string[] | null {
  const env = process.env.TEROS_VISION_MODEL_PATTERNS;
  if (env) {
    return env.split(',').map((p) => p.trim()).filter(Boolean);
  }
  return null;
}

export interface ImagePipelineOptions {
  /** Allowed domains for image URL validation. If omitted, uses TEROS_FILE_DOMAIN env var. */
  allowedDomains?: string[] | null;
  /** Vision-capable model name patterns (case-insensitive substring match).
   *  If omitted, uses TEROS_VISION_MODEL_PATTERNS env var or built-in defaults. */
  visionPatterns?: string[] | null;
}

export class ImagePipeline {
  private cache = new Map<string, CacheEntry>();
  private currentCacheSize = 0;
  private allowedDomains: string[] | null;
  private visionPatterns: string[];

  constructor(options?: ImagePipelineOptions) {
    // Resolve at construction time so tests can mutate process.env between instances
    this.allowedDomains = options?.allowedDomains !== undefined
      ? options.allowedDomains
      : getDefaultAllowedDomains();
    const envPatterns = getEnvVisionPatterns();
    this.visionPatterns = options?.visionPatterns !== undefined
      ? (options.visionPatterns ?? DEFAULT_VISION_PATTERNS)
      : (envPatterns ?? DEFAULT_VISION_PATTERNS);
  }

  /**
   * Process multiple image FileParts into a map of URL -> ProcessedImage
   *
   * @param parts - FilePart entries to process (only image/* mime types are processed)
   * @param provider - Provider name for limit configuration
   * @returns Map of URL to processed image (only successful conversions)
   */
  async processImages(parts: FilePart[], provider: string): Promise<Map<string, ProcessedImage>> {
    const result = new Map<string, ProcessedImage>();
    const imageParts = parts.filter((p) => p.mime?.startsWith('image/'));

    if (imageParts.length === 0) {
      return result;
    }

    const limits = this.getLimits(provider);

    // Check max images per request (Anthropic limit)
    const maxImages = limits.maxImagesPerRequest ?? Infinity;
    const partsToProcess = imageParts.slice(0, maxImages);

    if (imageParts.length > maxImages) {
      log.warn('ImagePipeline', `Truncating images from ${imageParts.length} to ${maxImages} for provider ${provider}`);
    }

    for (const part of partsToProcess) {
      try {
        const processed = await this.processImage(part.url, part.mime, limits, provider);
        if (processed) {
          result.set(part.url, processed);
        }
      } catch (error: any) {
        log.error('ImagePipeline', `Failed to process image ${part.url}`, undefined, { url: part.url, mime: part.mime, reason: error.message });
        // Continue - skip this image, don't fail the whole request
      }
    }

    return result;
  }

  /**
   * Process an in-memory image buffer (no URL download, no allowlist check).
   *
   * Used for images that already arrived through a trusted path — typically
   * embedded attachments inside an Office document that we extracted with
   * DocumentExtractor. The data does not pass through the public-URL allowlist
   * because it never traversed an HTTP boundary; it came from a file the user
   * already uploaded through the authenticated /api/upload/static endpoint.
   *
   * Applies the same resize + reformat pipeline as `processImage`, so the
   * resulting base64 fits the provider's limits.
   */
  async processBuffer(
    buffer: Buffer,
    mimeType: string,
    provider: string,
  ): Promise<ProcessedImage | null> {
    if (!mimeType.startsWith('image/')) return null;
    const limits = this.getLimits(provider);
    if (!limits.formats.includes(mimeType)) {
      log.warn('ImagePipeline', `Unsupported format ${mimeType} for provider, converting to JPEG`);
    }
    try {
      return await this.resizeAndConvert(buffer, mimeType, limits);
    } catch (error: any) {
      log.error('ImagePipeline', `Failed to process buffer: ${error.message}`, undefined, { mime: mimeType, reason: error.message });
      return null;
    }
  }

  /**
   * Process a single image URL
   *
   * @param url - Image URL to download
   * @param mimeType - Expected MIME type
   * @param limits - Provider limits
   * @returns ProcessedImage or null if skipped
   */
  private async processImage(
    url: string,
    mimeType: string,
    limits: { maxSizeBytes: number; maxDimension: number; formats: string[] },
    provider: string,
  ): Promise<ProcessedImage | null> {
    // Cache key includes provider so different providers get correctly sized/formatted images
    const cacheKey = `${url}::${provider}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      log.debug('ImagePipeline', 'Cache hit', { url, provider });
      return cached;
    }

    // Validate URL
    if (!this.isValidUrl(url)) {
      log.error('ImagePipeline', `Invalid or non-allowed URL: ${url}`, undefined, { url });
      return null;
    }

    // Check format support
    if (!limits.formats.includes(mimeType)) {
      log.warn('ImagePipeline', `Unsupported format ${mimeType} for provider, converting to JPEG`);
    }

    // Download image
    const buffer = await this.downloadImage(url);
    if (!buffer) {
      return null;
    }

    // Process with sharp
    const processed = await this.resizeAndConvert(buffer, mimeType, limits);

    // Add to cache (keyed by url::provider)
    if (processed) {
      this.addToCache(cacheKey, processed);
    }

    return processed;
  }

  /**
   * Download image from URL with timeout and size limits.
   * Supports both remote URLs (via fetch) and local workspace paths (via fs.readFile).
   * @todo pablo - 2026.05.24 : local workspace path handling is a temporary workaround.
   *   Once user file storage (S3/internal service) is implemented, all file references
   *   should use teros-internal URLs and this fs.readFile fallback should be removed.
   */
  private async downloadImage(url: string): Promise<Buffer | null> {
    // Handle local workspace paths
    if (url.startsWith('/workspace/')) {
      // Defence at the sink: re-check traversal here too, so a future caller
      // that reaches downloadImage without going through isValidUrl still
      // cannot read outside the workspace mount.
      if (!isInsideWorkspace(url)) {
        log.error('ImagePipeline', `Rejected workspace path traversal: ${url}`, undefined, { url });
        return null;
      }
      try {
        const buffer = await fs.readFile(url);
        if (buffer.length > MAX_DOWNLOAD_SIZE_BYTES) {
          log.error('ImagePipeline', `Local image too large: ${buffer.length} bytes`, undefined, { url });
          return null;
        }
        log.debug('ImagePipeline', 'Read local image', { url, size: buffer.length });
        return buffer;
      } catch (error: any) {
        log.error('ImagePipeline', `Failed to read local file: ${error.message}`, undefined, { url });
        return null;
      }
    }

    // Remote URL via fetch
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

      // Follow redirects MANUALLY so every hop is re-validated against the
      // allowlist. The default `redirect: 'follow'` would let an allowed host
      // with an open redirect bounce the download to an internal IP / cloud
      // metadata endpoint (169.254.169.254) — a classic SSRF. We cap hops and
      // reject any Location that fails isValidUrl.
      let response: Response;
      let currentUrl = url;
      let hop = 0;
      try {
        while (true) {
          response = await fetch(currentUrl, {
            signal: controller.signal,
            redirect: 'manual',
          });

          if (response.status < 300 || response.status >= 400) break;

          // Redirect: validate the next hop before following it.
          if (hop >= MAX_DOWNLOAD_REDIRECTS) {
            log.error('ImagePipeline', `Too many redirects (>${MAX_DOWNLOAD_REDIRECTS})`, undefined, { url });
            return null;
          }
          const location = response.headers.get('location');
          if (!location) {
            log.error('ImagePipeline', `Redirect with no Location header`, undefined, { url, status: response.status });
            return null;
          }
          let nextUrl: string;
          try {
            nextUrl = new URL(location, currentUrl).toString();
          } catch {
            log.error('ImagePipeline', `Malformed redirect Location: ${location}`, undefined, { url });
            return null;
          }
          if (!this.isValidUrl(nextUrl)) {
            log.error('ImagePipeline', `Blocked SSRF redirect to non-allowed target: ${nextUrl}`, undefined, { url, redirectTo: nextUrl });
            return null;
          }
          currentUrl = nextUrl;
          hop++;
        }
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        log.error('ImagePipeline', `Download failed: ${response.status} ${response.statusText}`, undefined, { url });
        return null;
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_SIZE_BYTES) {
        log.error('ImagePipeline', `Image too large: ${contentLength} bytes > ${MAX_DOWNLOAD_SIZE_BYTES}`, undefined, { url });
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > MAX_DOWNLOAD_SIZE_BYTES) {
        log.error('ImagePipeline', `Downloaded image too large: ${buffer.length} bytes`, undefined, { url });
        return null;
      }

      log.debug('ImagePipeline', 'Downloaded image', { url, size: buffer.length });
      return buffer;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        log.error('ImagePipeline', `Download timeout after ${DOWNLOAD_TIMEOUT_MS}ms`, undefined, { url });
      } else {
        log.error('ImagePipeline', `Download error: ${error.message}`, undefined, { url });
      }
      return null;
    }
  }

  /**
   * Resize and convert image to meet provider limits
   */
  private async resizeAndConvert(
    buffer: Buffer,
    originalMime: string,
    limits: { maxSizeBytes: number; maxDimension: number; formats: string[] },
  ): Promise<ProcessedImage | null> {
    try {
      let pipeline = sharp(buffer);

      // Get metadata
      const metadata = await pipeline.metadata();
      const originalWidth = metadata.width ?? 0;
      const originalHeight = metadata.height ?? 0;

      // Resize if dimensions exceed limit
      let needsResize = false;
      let targetWidth = originalWidth;
      let targetHeight = originalHeight;

      if (originalWidth > limits.maxDimension || originalHeight > limits.maxDimension) {
        needsResize = true;
        const ratio = Math.min(
          limits.maxDimension / originalWidth,
          limits.maxDimension / originalHeight,
        );
        targetWidth = Math.round(originalWidth * ratio);
        targetHeight = Math.round(originalHeight * ratio);
      }

      // If image is very large, also reduce to 2048x2048 max for safety
      const SAFE_MAX_DIMENSION = 2048;
      if (targetWidth > SAFE_MAX_DIMENSION || targetHeight > SAFE_MAX_DIMENSION) {
        needsResize = true;
        const ratio = Math.min(
          SAFE_MAX_DIMENSION / targetWidth,
          SAFE_MAX_DIMENSION / targetHeight,
        );
        targetWidth = Math.round(targetWidth * ratio);
        targetHeight = Math.round(targetHeight * ratio);
      }

      if (needsResize) {
        pipeline = pipeline.resize(targetWidth, targetHeight, { fit: 'inside' });
        log.debug('ImagePipeline', 'Resizing image', {
          from: `${originalWidth}x${originalHeight}`,
          to: `${targetWidth}x${targetHeight}`,
        });
      }

      // Convert to JPEG for best compression if needed, or keep original format
      // Use JPEG quality 85 for output
      const outputFormat = originalMime === 'image/png' ? 'png' : 'jpeg';
      const outputMime = outputFormat === 'png' ? 'image/png' : 'image/jpeg';

      let outputBuffer: Buffer;
      if (outputFormat === 'jpeg') {
        outputBuffer = await pipeline.jpeg({ quality: 85 }).toBuffer();
      } else {
        outputBuffer = await pipeline.png().toBuffer();
      }

      // Check if still too large after resize - try again with more aggressive compression
      if (outputBuffer.length > limits.maxSizeBytes) {
        log.debug('ImagePipeline', `Image still too large (${outputBuffer.length} bytes), applying aggressive compression`);

        // Restart pipeline
        pipeline = sharp(buffer);
        if (needsResize) {
          pipeline = pipeline.resize(targetWidth, targetHeight, { fit: 'inside' });
        }

        // Try JPEG at quality 70
        outputBuffer = await pipeline.jpeg({ quality: 70 }).toBuffer();

        if (outputBuffer.length > limits.maxSizeBytes) {
          // Last resort: reduce dimensions further
          const ratio = Math.sqrt(limits.maxSizeBytes / outputBuffer.length) * 0.9;
          const finalWidth = Math.max(1, Math.round(targetWidth * ratio));
          const finalHeight = Math.max(1, Math.round(targetHeight * ratio));

          pipeline = sharp(buffer).resize(finalWidth, finalHeight, { fit: 'inside' });
          outputBuffer = await pipeline.jpeg({ quality: 70 }).toBuffer();

          if (outputBuffer.length > limits.maxSizeBytes) {
            log.error('ImagePipeline', `Cannot resize image under limit: ${outputBuffer.length} > ${limits.maxSizeBytes}`, undefined, { outputBufferLength: outputBuffer.length, limit: limits.maxSizeBytes });
            return null;
          }
        }
      }

      const base64 = outputBuffer.toString('base64');
      const processed: ProcessedImage = {
        base64,
        mimeType: outputMime,
        width: targetWidth,
        height: targetHeight,
        sizeBytes: base64.length,
      };

      log.debug('ImagePipeline', 'Image processed', {
        originalSize: buffer.length,
        processedSize: outputBuffer.length,
        base64Size: base64.length,
        dimensions: `${targetWidth}x${targetHeight}`,
      });

      return processed;
    } catch (error: any) {
      log.error('ImagePipeline', `Image processing error: ${error.message}`, undefined, { reason: error.message });
      return null;
    }
  }

  /**
   * Get provider limits by name
   */
  private getLimits(provider: string): { maxSizeBytes: number; maxDimension: number; formats: string[]; maxImagesPerRequest?: number } {
    const normalized = provider.toLowerCase();
    // Check for provider name in the string
    for (const [key, limits] of Object.entries(PROVIDER_LIMITS)) {
      if (normalized.includes(key)) {
        return limits;
      }
    }
    return DEFAULT_LIMITS;
  }

  /**
   * Validate URL - allow http/https from expected domains OR local workspace paths.
   * Fail-closed: if no allowed domains are configured, reject all remote URLs.
   * @todo pablo - 2026.05.24 : replace local workspace path handling with S3/internal
   *   file service once user file storage is implemented. Current workaround reads
   *   directly from /workspace/ which works for all MCAs (Playwright, Drive, Gmail, etc.)
   *   but will be replaced by teros-internal URLs when the user file system is ready.
   */
  private isValidUrl(url: string): boolean {
    // Allow local workspace paths (used by MCAs that save files to /workspace/),
    // but normalise first and reject anything that escapes the workspace root
    // via `..` traversal. Without this, `/workspace/../../etc/passwd` would
    // reach `fs.readFile` in downloadImage and leak arbitrary host files
    // whenever an MCA can influence `part.url`.
    if (url.startsWith('/workspace/')) {
      return isInsideWorkspace(url);
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
      }
      // Fail closed: if no allowed domains configured, reject everything
      if (!this.allowedDomains || this.allowedDomains.length === 0) {
        log.warn('ImagePipeline', 'URL rejected: no allowed domains configured (TEROS_FILE_DOMAIN env var not set)', { url });
        return false;
      }
      // Check hostname against allowed domains (exact match or subdomain)
      const hostname = parsed.hostname.toLowerCase();
      for (const allowed of this.allowedDomains) {
        const allowedLower = allowed.toLowerCase();
        if (hostname === allowedLower || hostname.endsWith(`.${allowedLower}`)) {
          return true;
        }
      }
      log.warn('ImagePipeline', `URL rejected: domain ${hostname} not in allowed list`, { url, allowedDomains: this.allowedDomains });
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get image from cache if not expired
   */
  private getFromCache(url: string): ProcessedImage | null {
    const entry = this.cache.get(url);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > CACHE_TTL_MS) {
      // Expired - remove
      this.cache.delete(url);
      this.currentCacheSize -= entry.image.sizeBytes;
      return null;
    }

    return entry.image;
  }

  /**
   * Add processed image to cache with LRU eviction
   */
  private addToCache(url: string, image: ProcessedImage): void {
    // Evict oldest entries if cache would exceed max size
    while (this.currentCacheSize + image.sizeBytes > MAX_CACHE_SIZE_BYTES && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        const oldest = this.cache.get(oldestKey);
        if (oldest) {
          this.currentCacheSize -= oldest.image.sizeBytes;
        }
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(url, { image, timestamp: Date.now() });
    this.currentCacheSize += image.sizeBytes;
  }

  /**
   * Check if a model string supports vision.
   * Matches against configurable patterns (instance-level or env-level).
   */
  supportsVision(modelString: string): boolean {
    const model = modelString.toLowerCase();
    return this.visionPatterns.some((v) => model.includes(v));
  }

  /**
   * Static convenience method that uses default patterns.
   * Prefer the instance method for configurable behavior.
   */
  static supportsVision(modelString: string): boolean {
    const model = modelString.toLowerCase();
    const patterns = getEnvVisionPatterns() ?? DEFAULT_VISION_PATTERNS;
    return patterns.some((v) => model.includes(v));
  }
}
