/**
 * Media persistence helpers for MCAs.
 *
 * Standard pattern for any MCA that produces media (images, video, audio,
 * files) at external, ephemeral URLs: download the content and persist it
 * into the platform's object storage (`ctx.objects`), returning a permanent
 * internal URL instead of the third-party one.
 *
 * Why: external URLs (Replicate's CDN, higgsfield, elevenlabs, etc.) expire
 * or are bound to localhost. Pablo's decision (2026-10-20): every MCA MUST
 * return objects-system URLs — never localhost paths or third-party
 * ephemeral URLs — as tool output.
 *
 * Pattern extracted from `mca.replicate/src/index.ts` (WS1b).
 */

import type { ObjectStorage } from './types';

/** Default maximum object size for `ctx.objects` (50MB). Files exceeding
 *  this are returned with the original external URL + a warning. */
export const DEFAULT_MAX_MEDIA_SIZE = 50 * 1024 * 1024;

/** Default content type used when the origin server does not provide one. */
export const DEFAULT_MEDIA_CONTENT_TYPE = 'application/octet-stream';

/**
 * Minimal context shape required by the persistence helpers.
 * Compatible with the SDK's `ToolContext` — anything with an `objects`
 * field implementing `ObjectStorage` works.
 */
export interface MediaPersistenceContext {
  objects: ObjectStorage;
}

/**
 * Options accepted by {@link persistExternalMedia} and
 * {@link persistExternalMediaOutput}.
 */
export interface PersistExternalMediaOptions {
  /**
   * Maximum allowed object size in bytes. If the remote file exceeds this,
   * the helper returns the original URL with a `warning` instead of
   * persisting. Defaults to {@link DEFAULT_MAX_MEDIA_SIZE} (50MB).
   */
  maxSizeBytes?: number;

  /**
   * Source identifier recorded in the object's metadata (e.g. 'replicate',
   * 'elevenlabs', 'higgsfield'). Strongly recommended — the object store
   * is shared per app installation and this is the primary way to trace
   * where an object came from.
   */
  source?: string;

  /**
   * Extra metadata stored alongside the object. `source` and
   * `externalUrl` are always set by the helper; `metadata` is merged in
   * after, so callers can add model IDs, prediction IDs, prompt info, etc.
   */
  metadata?: Record<string, string>;

  /**
   * Fallback content type if the origin server does not send a
   * `content-type` header. Defaults to {@link DEFAULT_MEDIA_CONTENT_TYPE}.
   */
  defaultContentType?: string;

  /**
   * Optional fetch implementation override. Primarily for tests — in
   * production the global `fetch` is used.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Result of persisting a single external URL.
 */
export interface PersistedMedia {
  /** The internal permanent URL (or the original external URL if persistence failed). */
  url: string;
  /** The objectId in `ctx.objects` (null if not persisted). */
  objectId: string | null;
  /** Warning message if the file could not be persisted (e.g. size limit). */
  warning?: string;
}

/**
 * Check whether a value looks like an HTTP(S) URL that should be persisted.
 *
 * We deliberately do NOT match specific domains (replicate.delivery, etc.) —
 * providers change CDNs and any allowlist breaks silently. Any HTTP/HTTPS
 * string in a tool output is treated as a media URL to persist; non-URL
 * outputs (text, data URIs, structured data) are returned as-is.
 */
export function isExternalMediaUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * Download a file from an external URL and persist it in `ctx.objects`.
 * Returns the internal permanent URL and objectId.
 *
 * Behavior:
 * - Sends a HEAD request first to check `content-length`. If it exceeds
 *   `maxSizeBytes`, returns the original URL with a warning (no download).
 * - If HEAD fails or is unsupported, proceeds with GET and re-checks the
 *   actual downloaded size against `maxSizeBytes`.
 * - On GET failure (non-2xx), throws an Error — callers should treat this
 *   as a tool failure, not a warning, because the media is gone.
 *
 * @param url      External URL to download and persist.
 * @param ctx      Tool context (must expose `objects: ObjectStorage`).
 * @param options  Size limit, source, metadata, content-type fallback.
 */
export async function persistExternalMedia(
  url: string,
  ctx: MediaPersistenceContext,
  options: PersistExternalMediaOptions = {},
): Promise<PersistedMedia> {
  const maxSize = options.maxSizeBytes ?? DEFAULT_MAX_MEDIA_SIZE;
  const defaultContentType = options.defaultContentType ?? DEFAULT_MEDIA_CONTENT_TYPE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const source = options.source ?? 'unknown';

  // Check size via HEAD request to avoid downloading very large files
  try {
    const headResponse = await fetchImpl(url, { method: 'HEAD' });
    const contentLength = parseInt(headResponse.headers.get('content-length') || '0', 10);
    if (contentLength > maxSize) {
      return {
        url,
        objectId: null,
        warning: `File exceeds ${formatBytes(maxSize)} limit (${contentLength} bytes), returning temporary external URL`,
      };
    }
  } catch {
    // HEAD might not be supported — continue with GET and check actual size
  }

  // Download the file
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download external media: ${response.status} ${response.statusText}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Double-check actual size (HEAD may have been missing or inaccurate)
  if (buffer.length > maxSize) {
    return {
      url,
      objectId: null,
      warning: `File exceeds ${formatBytes(maxSize)} limit (${buffer.length} bytes), returning temporary external URL`,
    };
  }

  const contentType = response.headers.get('content-type') || defaultContentType;

  const result = await ctx.objects.put(buffer, contentType, {
    source,
    externalUrl: url,
    ...(options.metadata ?? {}),
  });

  return { url: result.url, objectId: result.objectId };
}

/**
 * Result of persisting an arbitrary tool output value.
 */
export interface PersistedMediaOutput {
  /** The persisted output — same shape as input but with internal URLs. */
  output: unknown;
  /** ObjectIds of persisted objects. */
  objectIds: string[];
  /** Warnings for files that could not be persisted. */
  warnings: string[];
  /** Original external URLs that were persisted (in traversal order). */
  externalUrls: string[];
  /** Internal URLs that replaced them (parallel to `externalUrls`). */
  internalUrls: string[];
}

/**
 * Persist an arbitrary tool output value into `ctx.objects`.
 *
 * Handles three cases:
 * - String URL → download and persist, return internal URL
 * - Array of URLs (and/or non-URL items) → persist each URL, keep others as-is
 * - Non-URL output (text, data URI, structured object) → return as-is
 *
 * The returned `externalUrls` / `internalUrls` pair is parallel — index `i`
 * in `internalUrls` is the permanent URL for `externalUrls[i]`. Callers can
 * use this to build a cache mapping (e.g. Replicate's prediction cache).
 */
export async function persistExternalMediaOutput(
  output: unknown,
  ctx: MediaPersistenceContext,
  options: PersistExternalMediaOptions = {},
): Promise<PersistedMediaOutput> {
  const warnings: string[] = [];
  const objectIds: string[] = [];
  const externalUrls: string[] = [];
  const internalUrls: string[] = [];

  // Single URL
  if (typeof output === 'string' && isExternalMediaUrl(output)) {
    const result = await persistExternalMedia(output, ctx, options);
    externalUrls.push(output);
    internalUrls.push(result.url);
    if (result.objectId) objectIds.push(result.objectId);
    if (result.warning) warnings.push(result.warning);
    return { output: result.url, objectIds, warnings, externalUrls, internalUrls };
  }

  // Array of URLs (some providers return multiple files)
  if (Array.isArray(output)) {
    const persistedItems: unknown[] = [];
    for (const item of output) {
      if (typeof item === 'string' && isExternalMediaUrl(item)) {
        const result = await persistExternalMedia(item, ctx, options);
        externalUrls.push(item);
        internalUrls.push(result.url);
        if (result.objectId) objectIds.push(result.objectId);
        if (result.warning) warnings.push(result.warning);
        persistedItems.push(result.url);
      } else {
        // Non-URL item (text, number, etc.) — keep as-is
        persistedItems.push(item);
      }
    }
    return { output: persistedItems, objectIds, warnings, externalUrls, internalUrls };
  }

  // Not a URL or array — return as-is (text output, data URI, etc.)
  return { output, objectIds, warnings, externalUrls, internalUrls };
}

/** Human-readable byte size for warning messages (e.g. "50MB"). */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}
