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
 * Append `; charset=utf-8` to a `text/*` Content-Type that lacks an explicit
 * charset. RFC 9110 dropped the historic `text/*` default of ISO-8859-1, so
 * without the parameter browsers guess the encoding (Chromium picks
 * windows-1252) and any non-ASCII UTF-8 text mojibakes when rendered inline
 * (`situaciÃ³n` instead of `situación`). An explicit charset on the input is
 * preserved as-is — never doubled, never overridden. Non-text types pass
 * through unchanged.
 */
export function withTextCharset(contentType: string): string {
  if (!contentType) return contentType;
  if (!normalizeMediaType(contentType).startsWith('text/')) return contentType;
  if (contentType.toLowerCase().includes('charset=')) return contentType;
  return `${contentType}; charset=utf-8`;
}

/**
 * Mutate `headers` in place with the download-safety headers and return it.
 * - Always sets `X-Content-Type-Options: nosniff`.
 * - Appends `; charset=utf-8` to a `text/*` Content-Type that lacks an explicit
 *   charset (see withTextCharset — RFC 9110 has no text/* default charset, so
 *   browsers guess windows-1252 and UTF-8 content mojibakes inline).
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
  if (headers['Content-Type']) {
    headers['Content-Type'] = withTextCharset(headers['Content-Type']);
  }
  if (FORCE_ATTACHMENT_TYPES.has(normalizeMediaType(mimeType))) {
    headers['Content-Disposition'] = `attachment; filename="${sanitizeContentDispositionFilename(filename)}"`;
  }
  return headers;
}

/**
 * Build the CSP `frame-ancestors` directive for inline-served user content
 * (security F1, review tn_KjOnSKdgygs1xbQu).
 *
 * `frame-ancestors 'self'` alone is NOT enough here: the app and the backend
 * are different origins (os.teros.ai embeds be.teros.ai — the same
 * cross-origin embed the nginx /media/ location already allows with
 * `frame-ancestors 'self' https://os.teros.ai`, FVU v1.3.7). The app viewer
 * (HtmlPreview iframe on the absolute object URL) and the FVU embeds would
 * break with 'self' only. The directive therefore allows 'self' plus the
 * CORS allowlist origins — our own first-party apps, which already hold API
 * access. A wildcard entry ('*') in the allowlist degrades to 'self' only
 * rather than re-opening framing to the whole web.
 */
export function buildFrameAncestorsDirective(corsAllowedOrigins: readonly string[]): string {
  const origins = corsAllowedOrigins
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && o !== '*');
  const unique = Array.from(new Set(["'self'", ...origins]));
  return `frame-ancestors ${unique.join(' ')}`;
}

/**
 * Inline-serving counterpart of applyDownloadSafetyHeaders, for routes that
 * DELIBERATELY render browser-executable user content in-page (security F1
 * containment, review tn_KjOnSKdgygs1xbQu): /objects/:id and /share/:id.
 *
 * Unlike the download paths (media/static/uploads force attachment), these
 * routes serve interactive deliverables (HTML with live scripts) inline — so
 * the containment is a CSP sandbox instead of a download:
 *
 * - `sandbox allow-scripts` → the document gets an OPAQUE origin: scripts run
 *   (deliverables stay interactive) but they cannot read Teros cookies or
 *   localStorage, and a fetch to /auth/session dies in CORS (Origin: null is
 *   not in the allowlist) — exactly the F1 vector closed at the browser level.
 *   NEVER add `allow-same-origin` alongside `allow-scripts`: that combination
 *   lets the content drop its own sandbox (same rule as the viewer fix,
 *   commit 4e693449e / b26905c46).
 * - `frame-ancestors <directive>` → only our own origins may embed the
 *   content; third parties cannot.
 *
 * Applied ONLY to browser-executable types (FORCE_ATTACHMENT_TYPES — the same
 * set the download paths force to attachment). Images, PDFs, audio/video,
 * text, JSON… get just nosniff: they cannot execute, and sandboxing them
 * would break nothing but add header noise.
 *
 * - Always sets `X-Content-Type-Options: nosniff` (also for non-executable
 *   types — a benign-looking file must never be MIME-sniffed back into HTML).
 * - Appends `; charset=utf-8` to a `text/*` Content-Type lacking one.
 * - Keeps the caller's Content-Disposition (inline serving is the point).
 */
export function applyInlineSafetyHeaders(
  headers: Record<string, string>,
  mimeType: string,
  frameAncestorsDirective: string,
): Record<string, string> {
  headers['X-Content-Type-Options'] = 'nosniff';
  if (headers['Content-Type']) {
    headers['Content-Type'] = withTextCharset(headers['Content-Type']);
  }
  if (FORCE_ATTACHMENT_TYPES.has(normalizeMediaType(mimeType))) {
    headers['Content-Security-Policy'] = `sandbox allow-scripts; ${frameAncestorsDirective}`;
  }
  return headers;
}
