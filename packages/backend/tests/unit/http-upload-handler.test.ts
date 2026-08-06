/**
 * Unit tests — file upload validation in http-upload-handler.ts
 *
 * Verifies that:
 *   1. resolveMimeType() correctly cross-checks file extension vs client-supplied type.
 *   2. parseMultipartFormData() enforces the streaming size cap (maxBytes).
 *   3. parseMultipartFormData() correctly parses a valid multipart body.
 *   4. parseMultipartFormData() returns null for non-multipart requests.
 *
 * No real HTTP server or MongoDB is required — all tests are pure unit tests.
 */

import { describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import { parseMultipartFormData, resolveMimeType } from '../../src/handlers/http-upload-handler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal IncomingMessage-like Readable stream from a Buffer,
 * with the given headers map.
 */
function makeRequest(
  body: Buffer,
  headers: Record<string, string>,
): NodeJS.ReadableStream & { headers: Record<string, string> } {
  const stream = Readable.from([body]) as any;
  stream.headers = headers;
  return stream;
}

/**
 * Build a valid multipart/form-data body containing a single file part.
 */
function buildMultipartBody(opts: {
  boundary: string;
  filename: string;
  contentType: string;
  fileContent: Buffer;
}): Buffer {
  const { boundary, filename, contentType, fileContent } = opts;
  const CRLF = '\r\n';
  const header = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
    '',
    '',
  ].join(CRLF);

  return Buffer.concat([
    Buffer.from(header),
    fileContent,
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
  ]);
}

// ---------------------------------------------------------------------------
// resolveMimeType()
// ---------------------------------------------------------------------------

describe('resolveMimeType()', () => {
  it('returns the extension-derived MIME type for a known .jpg file', () => {
    expect(resolveMimeType('photo.jpg', 'image/jpeg')).toBe('image/jpeg');
  });

  it('returns the extension-derived MIME type for a known .png file', () => {
    expect(resolveMimeType('avatar.png', 'image/png')).toBe('image/png');
  });

  it('returns the extension-derived MIME type for a known .pdf file', () => {
    expect(resolveMimeType('document.pdf', 'application/pdf')).toBe('application/pdf');
  });

  it('returns the extension-derived MIME type even when client claims a different type (spoofing)', () => {
    // Attacker uploads a .html file but claims image/jpeg → should resolve to text/html
    // so the whitelist check downstream will correctly reject it.
    expect(resolveMimeType('evil.html', 'image/jpeg')).toBe('text/html');
  });

  it('returns the extension-derived MIME type for .gif regardless of client type', () => {
    expect(resolveMimeType('anim.gif', 'application/octet-stream')).toBe('image/gif');
  });

  it('returns the extension-derived MIME type for .webp', () => {
    expect(resolveMimeType('image.webp', 'image/webp')).toBe('image/webp');
  });

  it('falls back to client-supplied MIME type for an unknown extension', () => {
    expect(resolveMimeType('data.bin', 'application/octet-stream')).toBe(
      'application/octet-stream',
    );
  });

  it('falls back to application/octet-stream when extension is unknown and client type is empty', () => {
    expect(resolveMimeType('noext', '')).toBe('application/octet-stream');
  });

  it('is case-insensitive for extensions (.JPG)', () => {
    expect(resolveMimeType('PHOTO.JPG', 'image/jpeg')).toBe('image/jpeg');
  });

  it('is case-insensitive for extensions (.PNG)', () => {
    expect(resolveMimeType('AVATAR.PNG', 'image/png')).toBe('image/png');
  });
});

// ---------------------------------------------------------------------------
// parseMultipartFormData() — size cap (streaming guard)
// ---------------------------------------------------------------------------

describe('parseMultipartFormData() — size cap', () => {
  const BOUNDARY = 'test-boundary-123';
  const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

  it('returns null when the body exceeds maxBytes', async () => {
    const largeContent = Buffer.alloc(1024 * 1024, 0x41); // 1 MB of 'A'
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      filename: 'large.jpg',
      contentType: 'image/jpeg',
      fileContent: largeContent,
    });

    const req = makeRequest(body, { 'content-type': CONTENT_TYPE });
    // Allow only 512 KB — body is 1 MB → should be rejected
    const result = await parseMultipartFormData(req as any, 512 * 1024);
    expect(result).toBeNull();
  });

  it('parses successfully when the body is within maxBytes', async () => {
    const smallContent = Buffer.from('hello world');
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      filename: 'hello.jpg',
      contentType: 'image/jpeg',
      fileContent: smallContent,
    });

    const req = makeRequest(body, { 'content-type': CONTENT_TYPE });
    const result = await parseMultipartFormData(req as any, 10 * 1024 * 1024); // 10 MB cap
    expect(result).not.toBeNull();
    expect(result?.filename).toBe('hello.jpg');
    expect(result?.file.toString()).toBe('hello world');
  });

  it('parses successfully when the body is exactly at maxBytes', async () => {
    // Build the body first to know its exact size, then set maxBytes to that size.
    const content = Buffer.from('exact');
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      filename: 'exact.png',
      contentType: 'image/png',
      fileContent: content,
    });

    const req = makeRequest(body, { 'content-type': CONTENT_TYPE });
    const result = await parseMultipartFormData(req as any, body.length);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseMultipartFormData() — MIME type resolution
// ---------------------------------------------------------------------------

describe('parseMultipartFormData() — MIME type resolution', () => {
  const BOUNDARY = 'mime-boundary-456';
  const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
  const MAX = 10 * 1024 * 1024;

  it('resolves MIME type from extension when client type matches', async () => {
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      fileContent: Buffer.from('fake-jpeg'),
    });
    const req = makeRequest(body, { 'content-type': CONTENT_TYPE });
    const result = await parseMultipartFormData(req as any, MAX);
    expect(result?.mimeType).toBe('image/jpeg');
  });

  it('resolves MIME type from extension even when client type is spoofed', async () => {
    // Client claims image/jpeg but the file is .html → should expose the real type
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      filename: 'evil.html',
      contentType: 'image/jpeg',
      fileContent: Buffer.from('<script>alert(1)</script>'),
    });
    const req = makeRequest(body, { 'content-type': CONTENT_TYPE });
    const result = await parseMultipartFormData(req as any, MAX);
    // The resolved MIME type should be text/html (from extension), NOT image/jpeg
    expect(result?.mimeType).toBe('text/html');
  });

  it('falls back to client-supplied MIME type for unknown extension', async () => {
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      filename: 'data.bin',
      contentType: 'application/octet-stream',
      fileContent: Buffer.from('\x00\x01\x02'),
    });
    const req = makeRequest(body, { 'content-type': CONTENT_TYPE });
    const result = await parseMultipartFormData(req as any, MAX);
    expect(result?.mimeType).toBe('application/octet-stream');
  });
});

// ---------------------------------------------------------------------------
// parseMultipartFormData() — invalid / missing content-type
// ---------------------------------------------------------------------------

describe('parseMultipartFormData() — invalid requests', () => {
  const MAX = 10 * 1024 * 1024;

  it('returns null when content-type is not multipart/form-data', async () => {
    const req = makeRequest(Buffer.from('hello'), { 'content-type': 'application/json' });
    const result = await parseMultipartFormData(req as any, MAX);
    expect(result).toBeNull();
  });

  it('returns null when content-type is missing', async () => {
    const req = makeRequest(Buffer.from('hello'), {});
    const result = await parseMultipartFormData(req as any, MAX);
    expect(result).toBeNull();
  });

  it('returns null when multipart boundary is missing from content-type', async () => {
    const req = makeRequest(Buffer.from('hello'), {
      'content-type': 'multipart/form-data',
    });
    const result = await parseMultipartFormData(req as any, MAX);
    expect(result).toBeNull();
  });

  it('returns null when multipart body contains no file part', async () => {
    const BOUNDARY = 'empty-boundary';
    // A multipart body with a text field (no filename) — no file part
    const CRLF = '\r\n';
    const body = Buffer.from(
      [
        `--${BOUNDARY}`,
        'Content-Disposition: form-data; name="field"',
        '',
        'value',
        `--${BOUNDARY}--`,
        '',
      ].join(CRLF),
    );
    const req = makeRequest(body, {
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    });
    const result = await parseMultipartFormData(req as any, MAX);
    expect(result).toBeNull();
  });
});
