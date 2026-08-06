/**
 * DocumentExtractor - Downloads and extracts plain text from Office/PDF documents
 *
 * Handles provider-agnostic document text extraction:
 * - Download from public URL (same allowlist as ImagePipeline)
 * - Parse via officeparser (DOCX/PPTX/XLSX/ODT/ODP/ODS/PDF/RTF)
 * - LRU cache with TTL
 *
 * This is the text-extraction counterpart to ImagePipeline: when a user attaches
 * an Office document, the adapter inlines the extracted text as a TextBlock so
 * even text-only models can reason about its content. Visual fidelity (slide
 * thumbnails, charts as images) is out of scope here — a future iteration may
 * add rasterisation for vision-capable models.
 */

import { OfficeParser } from 'officeparser';
import { log } from '../logger';
import type { FilePart } from '../session/types';
import { getDefaultAllowedDomains } from './ImagePipeline';
import { fetchFollowingRedirectsSafely } from './safe-fetch';

export interface ExtractedImageAttachment {
  /** Image MIME type as reported by officeparser (image/png, image/jpeg, ...). */
  mimeType: string;
  /** Raw image bytes — caller decides whether to resize/reencode or pass through. */
  buffer: Buffer;
}

export interface ExtractedDocument {
  /** Extracted plain text (slides joined, no formatting) */
  text: string;
  /** Original MIME type */
  mimeType: string;
  /** Source filename if known, otherwise basename of URL */
  filename: string;
  /** Length of extracted text in chars */
  charCount: number;
  /**
   * Images embedded inside the document (logos, charts rasterised as images,
   * brand guideline graphics). Empty array if none. Charts that officeparser
   * exposes as type 'chart' are skipped — only `type === 'image'` is included.
   */
  embeddedImages: ExtractedImageAttachment[];
}

interface CacheEntry {
  doc: ExtractedDocument;
  timestamp: number;
}

/** MIME types officeparser can extract. PDF is included; for plain text we delegate to a passthrough. */
const SUPPORTED_DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.oasis.opendocument.text', // .odt
  'application/vnd.oasis.opendocument.presentation', // .odp
  'application/vnd.oasis.opendocument.spreadsheet', // .ods
  'application/pdf',
  'application/rtf',
  'text/rtf',
]);

/** Plain-text MIMEs we pass through verbatim (no parsing). */
const PLAIN_TEXT_MIMES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/xml',
  'text/html',
  'text/x-python',
  'application/javascript',
  'application/typescript',
]);

/** Cache TTL (5 min, same as ImagePipeline) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum cache size in bytes (50MB) */
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024;

/** Maximum download size (100MB) */
const MAX_DOWNLOAD_SIZE_BYTES = 100 * 1024 * 1024;

/** Download timeout (30s) */
const DOWNLOAD_TIMEOUT_MS = 30 * 1000;

/**
 * Hard cap on extracted-text length per document, in chars. Documents that
 * extract beyond this are truncated with a marker — protects token budget
 * (~50k chars ≈ 12k tokens for English).
 */
const MAX_EXTRACTED_CHARS = 50_000;

/**
 * Hard cap on embedded images returned per document. Protects against decks
 * with hundreds of icons. Vision-capable providers also enforce their own
 * per-request cap (Anthropic = 20).
 */
const MAX_EMBEDDED_IMAGES = 20;

export interface DocumentExtractorOptions {
  /** Allowed domains for document URL validation. Defaults to getDefaultAllowedDomains() from ImagePipeline. */
  allowedDomains?: string[] | null;
  /** Override max extracted chars per document. */
  maxChars?: number;
  /** Override max embedded images returned per document. */
  maxImages?: number;
}

export class DocumentExtractor {
  private cache = new Map<string, CacheEntry>();
  private currentCacheSize = 0;
  private allowedDomains: string[] | null;
  private maxChars: number;
  private maxImages: number;

  constructor(options?: DocumentExtractorOptions) {
    this.allowedDomains =
      options?.allowedDomains !== undefined ? options.allowedDomains : getDefaultAllowedDomains();
    this.maxChars = options?.maxChars ?? MAX_EXTRACTED_CHARS;
    this.maxImages = options?.maxImages ?? MAX_EMBEDDED_IMAGES;
  }

  /**
   * Check whether a given MIME type can be extracted to text.
   * Used by adapters to filter FileParts before calling extractDocuments.
   */
  static supportsDocument(mime: string | undefined): boolean {
    if (!mime) return false;
    return SUPPORTED_DOCUMENT_MIMES.has(mime) || PLAIN_TEXT_MIMES.has(mime);
  }

  supportsDocument(mime: string | undefined): boolean {
    return DocumentExtractor.supportsDocument(mime);
  }

  /**
   * Extract plain text from one or more FileParts (non-image, supported MIME).
   * Returns Map of url → ExtractedDocument. Failures are logged and skipped.
   */
  async extractDocuments(parts: FilePart[]): Promise<Map<string, ExtractedDocument>> {
    const result = new Map<string, ExtractedDocument>();
    const docParts = parts.filter((p) => DocumentExtractor.supportsDocument(p.mime));
    if (docParts.length === 0) return result;

    for (const part of docParts) {
      try {
        const extracted = await this.extractDocument(part.url, part.mime, part.filename);
        if (extracted) {
          result.set(part.url, extracted);
        }
      } catch (error: any) {
        log.error('DocumentExtractor', `Failed to extract ${part.url}`, undefined, {
          url: part.url,
          mime: part.mime,
          reason: error.message,
        });
      }
    }
    return result;
  }

  private async extractDocument(
    url: string,
    mime: string,
    filename?: string,
  ): Promise<ExtractedDocument | null> {
    const cached = this.getFromCache(url);
    if (cached) {
      log.debug('DocumentExtractor', 'Cache hit', { url });
      return cached;
    }

    if (!this.isValidUrl(url)) {
      log.error('DocumentExtractor', `Invalid or non-allowed URL: ${url}`, undefined, { url });
      return null;
    }

    const buffer = await this.downloadDocument(url);
    if (!buffer) return null;

    const resolvedFilename = filename ?? this.deriveFilename(url);

    let text: string;
    let embeddedImages: ExtractedImageAttachment[] = [];
    try {
      if (PLAIN_TEXT_MIMES.has(mime)) {
        text = buffer.toString('utf-8');
        // Plain text MIMEs have no embedded images by definition.
      } else {
        const ast = await OfficeParser.parseOffice(buffer, {
          ignoreNotes: false,
          // Extract embedded images (logos, brand graphics) so adapters can pass them
          // to vision-capable models as image_url[] alongside the text.
          extractAttachments: true,
        } as any);
        text = ast.toText();

        const attachments = (ast as any).attachments as
          | Array<{ type: string; mimeType: string; data: string }>
          | undefined;
        if (Array.isArray(attachments)) {
          for (const att of attachments) {
            if (att.type !== 'image') continue;
            if (!att.mimeType?.startsWith('image/')) continue;
            try {
              embeddedImages.push({
                mimeType: att.mimeType,
                buffer: Buffer.from(att.data, 'base64'),
              });
            } catch {
              // Skip malformed base64 silently — adapter doesn't need to know.
            }
            if (embeddedImages.length >= this.maxImages) break;
          }
        }
      }
    } catch (error: any) {
      log.error('DocumentExtractor', `Parse failed for ${resolvedFilename}`, undefined, {
        url,
        mime,
        reason: error.message,
      });
      return null;
    }

    text = text.trim();
    if (text.length === 0 && embeddedImages.length === 0) {
      log.warn('DocumentExtractor', `Empty extraction for ${resolvedFilename}`, { url, mime });
      return null;
    }

    let truncated = false;
    if (text.length > this.maxChars) {
      text = `${text.slice(0, this.maxChars)}\n\n[…content truncated — original was ${text.length} chars]`;
      truncated = true;
    }

    const extracted: ExtractedDocument = {
      text,
      mimeType: mime,
      filename: resolvedFilename,
      charCount: text.length,
      embeddedImages,
    };

    log.debug('DocumentExtractor', 'Extracted document', {
      url,
      mime,
      filename: resolvedFilename,
      bytes: buffer.length,
      chars: text.length,
      embeddedImages: embeddedImages.length,
      truncated,
    });

    this.addToCache(url, extracted);
    return extracted;
  }

  private async downloadDocument(url: string): Promise<Buffer | null> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

      // Follow redirects manually, re-validating every hop against the allowlist
      // — an allowed host with an open redirect could otherwise bounce us to an
      // internal IP / cloud metadata endpoint (SSRF). TER-508 (gemelo de TER-458).
      const response = await fetchFollowingRedirectsSafely(url, {
        isValidUrl: (candidate) => this.isValidUrl(candidate),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        log.error(
          'DocumentExtractor',
          `Download failed: ${response.status} ${response.statusText}`,
          undefined,
          { url },
        );
        return null;
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_SIZE_BYTES) {
        log.error('DocumentExtractor', `Document too large: ${contentLength} bytes`, undefined, {
          url,
        });
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      if (buffer.length > MAX_DOWNLOAD_SIZE_BYTES) {
        log.error('DocumentExtractor', `Document too large: ${buffer.length} bytes`, undefined, {
          url,
        });
        return null;
      }

      return buffer;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        log.error('DocumentExtractor', `Download timeout after ${DOWNLOAD_TIMEOUT_MS}ms`, undefined, {
          url,
        });
      } else {
        log.error('DocumentExtractor', `Download error: ${error.message}`, undefined, { url });
      }
      return null;
    }
  }

  private isValidUrl(url: string): boolean {
    // Mirror ImagePipeline.isValidUrl: same allowlist semantics.
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
      }
      if (!this.allowedDomains || this.allowedDomains.length === 0) {
        log.warn(
          'DocumentExtractor',
          'URL rejected: no allowed domains configured (TEROS_FILE_DOMAIN env var not set)',
          { url },
        );
        return false;
      }
      const hostname = parsed.hostname.toLowerCase();
      for (const allowed of this.allowedDomains) {
        const allowedLower = allowed.toLowerCase();
        if (hostname === allowedLower || hostname.endsWith(`.${allowedLower}`)) {
          return true;
        }
      }
      log.warn('DocumentExtractor', `URL rejected: domain ${hostname} not in allowed list`, {
        url,
        allowedDomains: this.allowedDomains,
      });
      return false;
    } catch {
      return false;
    }
  }

  private deriveFilename(url: string): string {
    try {
      const parsed = new URL(url);
      const last = parsed.pathname.split('/').filter(Boolean).pop();
      return last || 'document';
    } catch {
      return 'document';
    }
  }

  private getFromCache(url: string): ExtractedDocument | null {
    const entry = this.cache.get(url);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      this.cache.delete(url);
      this.currentCacheSize -= entry.doc.text.length;
      return null;
    }
    return entry.doc;
  }

  private addToCache(url: string, doc: ExtractedDocument): void {
    while (this.currentCacheSize + doc.charCount > MAX_CACHE_SIZE_BYTES && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        const oldest = this.cache.get(oldestKey);
        if (oldest) this.currentCacheSize -= oldest.doc.charCount;
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(url, { doc, timestamp: Date.now() });
    this.currentCacheSize += doc.charCount;
  }
}

/**
 * Helper used by adapters: turn a set of extracted documents into a single
 * TextBlock-ready string. Prefixes each document with its filename so the
 * model can refer to it; appends a clear "end of document" marker.
 *
 * Returns null when nothing was extracted (caller should not inject anything).
 */
export function formatDocumentsAsText(docs: Map<string, ExtractedDocument>): string | null {
  if (docs.size === 0) return null;
  const blocks: string[] = [];
  for (const doc of docs.values()) {
    const embeddedCount = doc.embeddedImages?.length ?? 0;
    const imageNote =
      embeddedCount > 0 ? ` (${embeddedCount} embedded image(s) attached separately)` : '';
    blocks.push(
      `[Document: ${doc.filename}${imageNote}]\n${doc.text}\n[End of document: ${doc.filename}]`,
    );
  }
  return blocks.join('\n\n');
}

/**
 * Flatten all embedded images across extracted documents into a single list,
 * tagged with their source filename so adapters can pass them through the
 * ImagePipeline (resize/reformat per provider limits) and inline them as
 * image_url[] / ImageBlockParam[] alongside the document text.
 */
export function collectEmbeddedImages(
  docs: Map<string, ExtractedDocument>,
): Array<{ filename: string; mimeType: string; buffer: Buffer }> {
  const out: Array<{ filename: string; mimeType: string; buffer: Buffer }> = [];
  for (const doc of docs.values()) {
    for (const img of doc.embeddedImages) {
      out.push({ filename: doc.filename, mimeType: img.mimeType, buffer: img.buffer });
    }
  }
  return out;
}
