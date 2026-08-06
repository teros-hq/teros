/**
 * MIME helpers for Drive: deciding whether bytes are safe to decode as UTF-8
 * text (reads), deriving a file's Content-Type from its extension (uploads),
 * and mapping to Google Workspace native formats (conversion on create).
 */

/**
 * MIME types whose bytes are safe to decode as UTF-8 text. Anything else
 * (PDF, Word, images, archives, octet-stream…) is binary: decoding it would
 * yield garbage, so callers fail loud with an actionable error instead.
 */
export const TEXTUAL_MIME_PATTERNS: RegExp[] = [
  /^text\//,
  /\/(json|xml|csv|javascript|x-yaml|yaml|x-sh|html)$/,
  /\+(json|xml)$/,
];

export function isTextualMimeType(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  return TEXTUAL_MIME_PATTERNS.some((re) => re.test(mimeType));
}

/**
 * Google Workspace native target MIME types. Setting one of these as the
 * `requestBody.mimeType` on `files.create` tells Drive to CONVERT the uploaded
 * bytes into that native format (Docs/Sheets/Slides) — provided the source
 * `media.mimeType` is in the account's `importFormats` (e.g. text/html →
 * document). Without a native target, Drive stores the raw bytes verbatim.
 * See https://developers.google.com/workspace/drive/api/guides/manage-uploads
 */
export const GOOGLE_NATIVE_MIME = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
} as const;

export type GoogleNativeTarget = keyof typeof GOOGLE_NATIVE_MIME;

/**
 * Source MIME type for each `contentType` accepted by create-document. These
 * are all in Drive's `importFormats` mapping to `application/vnd.google-apps.document`,
 * so Drive converts the bytes into a native, editable Google Doc.
 */
export const CONTENT_TYPE_SOURCE_MIME = {
  html: 'text/html',
  markdown: 'text/markdown',
  text: 'text/plain',
} as const;

export type DocumentContentType = keyof typeof CONTENT_TYPE_SOURCE_MIME;

/**
 * Extension → MIME type for deriving the real Content-Type of an uploaded
 * file. Used by upload-file so Drive stores (and, when asked, converts) the
 * bytes with their true type instead of the generic application/octet-stream,
 * which Drive can neither preview nor convert.
 */
const EXT_MIME: Record<string, string> = {
  // text / markup
  txt: 'text/plain',
  text: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  rtf: 'application/rtf',
  // office
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // opendocument
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  // documents
  pdf: 'application/pdf',
  // images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  // archives
  zip: 'application/zip',
  gz: 'application/gzip',
};

/**
 * Derive a MIME type from a file name/path by its extension. Returns
 * `application/octet-stream` for unknown/extensionless files (a safe binary
 * default Drive stores verbatim).
 */
export function extToMime(fileNameOrPath: string): string {
  const lastDot = fileNameOrPath.lastIndexOf('.');
  if (lastDot < 0 || lastDot === fileNameOrPath.length - 1) {
    return 'application/octet-stream';
  }
  const ext = fileNameOrPath.slice(lastDot + 1).toLowerCase();
  return EXT_MIME[ext] ?? 'application/octet-stream';
}
