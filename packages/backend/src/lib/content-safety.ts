/**
 * Content-type safety for file-download HTTP responses.
 *
 * A file served with a browser-executable Content-Type and `Content-Disposition:
 * inline` runs in the *serving origin's* security context. For user-uploaded
 * content (media, static assets) that is Stored XSS on a trusted domain
 * (be.teros.ai): an SVG or HTML file carrying an inline `<script>` executes for
 * any victim who opens its URL. The defence is two-fold:
 *   (a) force `Content-Disposition: attachment` for the dangerous types so the
 *       browser downloads the file instead of rendering it, and
 *   (b) send `X-Content-Type-Options: nosniff` so the browser cannot MIME-sniff
 *       a benign-looking file (wrong/absent extension) back into HTML/SVG.
 *
 * The set + helper live here, shared by the static-file handler and the media
 * handler, so the two serving paths can never drift — a type protected on one
 * path but not the parallel one is the exact "gate on one path, not the other"
 * class of authorization/hardening bug.
 */

/** MIME types a browser will execute in the page context if served inline. */
export const FORCE_ATTACHMENT_TYPES: ReadonlySet<string> = new Set<string>([
  'text/html',
  'application/xhtml+xml',
  'application/javascript',
  'text/javascript',
  'image/svg+xml',
  'text/xml',
  'application/xml',
]);

/**
 * Normalise a Content-Type header value to its bare media type: drop parameters
 * (`; charset=…`), surrounding whitespace, and case. Without this, a crafted
 * upload mimeType like `image/svg+xml; x=1` or `IMAGE/SVG+XML` would slip past
 * an exact `Set.has()` check while the browser still renders it as SVG.
 */
export function normalizeMediaType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

/**
 * Strip characters that would break out of a `Content-Disposition` filename or
 * inject additional header lines. User-supplied filenames otherwise reach this
 * header verbatim (quotes end the value; CR/LF split the response). Keeps a
 * conservative subset and never returns an empty string.
 */
export function sanitizeContentDispositionFilename(filename: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars (CR/LF/NUL) from a header value
  const cleaned = filename.replace(/[\\/"\r\n\t\x00-\x1f\x7f]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'download';
}

/**
 * Mutate `headers` in place with the download-safety headers and return it.
 * - Always sets `X-Content-Type-Options: nosniff`.
 * - For a dangerous (browser-executable) `mimeType`, overrides
 *   `Content-Disposition` to `attachment` with a sanitized filename.
 *
 * A non-dangerous type keeps whatever `Content-Disposition` the caller set
 * (e.g. `inline` for images/PDFs that are meant to render in-page).
 */
export function applyDownloadSafetyHeaders(
  headers: Record<string, string>,
  mimeType: string,
  filename: string,
): Record<string, string> {
  headers['X-Content-Type-Options'] = 'nosniff';
  if (FORCE_ATTACHMENT_TYPES.has(normalizeMediaType(mimeType))) {
    headers['Content-Disposition'] = `attachment; filename="${sanitizeContentDispositionFilename(filename)}"`;
  }
  return headers;
}
