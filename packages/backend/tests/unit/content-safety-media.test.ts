/**
 * Unit + integration tests — content-safety (SEC-4 / A5, stored XSS via media).
 *
 * Two layers:
 *   1. applyDownloadSafetyHeaders / normalizeMediaType / sanitize… — the pure
 *      decision logic (which types get force-attached, nosniff always on, how a
 *      user filename is sanitized). Mutation-checked: flipping any branch flips a
 *      concrete assertion.
 *   2. HttpMediaHandler.handleRoute serving a REAL uploaded SVG through the real
 *      handler + fs — the path that actually shipped the bug. Before the fix the
 *      handler answered `Content-Disposition: inline` with the verbatim mimeType,
 *      so a victim opening /media/<id> for an SVG with <script> ran it on the
 *      backend origin. The integration test asserts the served headers, so a
 *      revert to the inline path turns it red.
 *
 * The media handler writes/reads under packages/backend/media (derived from the
 * handler's own __dirname). We mirror that path here and clean up per test.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyDownloadSafetyHeaders,
  FORCE_ATTACHMENT_TYPES,
  normalizeMediaType,
  sanitizeContentDispositionFilename,
} from '../../src/lib/content-safety';
import { HttpMediaHandler } from '../../src/handlers/http-media-handler';
import { handleUploadedFile, UPLOADS_DIR } from '../../src/bootstrap/http-server';

// ---------------------------------------------------------------------------
// 1. Pure helper
// ---------------------------------------------------------------------------

describe('applyDownloadSafetyHeaders', () => {
  it('always sets X-Content-Type-Options: nosniff', () => {
    const h = applyDownloadSafetyHeaders({ 'Content-Type': 'image/jpeg' }, 'image/jpeg', 'cat.jpg');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

  it('forces attachment for every browser-executable type', () => {
    for (const t of FORCE_ATTACHMENT_TYPES) {
      const h = applyDownloadSafetyHeaders({ 'Content-Disposition': 'inline; filename="x"' }, t, 'x');
      expect(h['Content-Disposition']).toBe('attachment; filename="x"');
    }
  });

  it('svg upload with inline script is force-attached (the A5 vector)', () => {
    const h = applyDownloadSafetyHeaders(
      { 'Content-Disposition': 'inline; filename="pwn.svg"' },
      'image/svg+xml',
      'pwn.svg',
    );
    expect(h['Content-Disposition']).toBe('attachment; filename="pwn.svg"');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

  it('does NOT force attachment for benign renderable types (keeps inline)', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
      const h = applyDownloadSafetyHeaders({ 'Content-Disposition': 'inline; filename="x"' }, t, 'x');
      expect(h['Content-Disposition']).toBe('inline; filename="x"');
    }
  });

  it('normalizes parameters and case so a crafted mimeType cannot evade the set', () => {
    for (const t of ['image/svg+xml; charset=utf-8', 'IMAGE/SVG+XML', '  text/html ', 'text/html;x=1']) {
      const h = applyDownloadSafetyHeaders({ 'Content-Disposition': 'inline; filename="x"' }, t, 'x');
      expect(h['Content-Disposition']).toBe('attachment; filename="x"');
    }
  });
});

describe('normalizeMediaType', () => {
  it('strips params, trims, lowercases', () => {
    expect(normalizeMediaType('image/svg+xml; charset=utf-8')).toBe('image/svg+xml');
    expect(normalizeMediaType('  TEXT/HTML  ')).toBe('text/html');
    expect(normalizeMediaType('application/json')).toBe('application/json');
  });
});

describe('sanitizeContentDispositionFilename', () => {
  it('strips quotes, path separators, control chars (CR/LF), backslashes', () => {
    expect(sanitizeContentDispositionFilename('evil".svg')).toBe('evil_.svg');
    expect(sanitizeContentDispositionFilename('a/b\\c')).toBe('a_b_c');
    expect(sanitizeContentDispositionFilename('a\r\nSet-Cookie: x')).toBe('a__Set-Cookie: x');
  });

  it('never returns empty (blank or whitespace-only → download)', () => {
    expect(sanitizeContentDispositionFilename('')).toBe('download');
    expect(sanitizeContentDispositionFilename('   ')).toBe('download');
  });
});

// ---------------------------------------------------------------------------
// 2. Media handler integration (real fs, real handler)
// ---------------------------------------------------------------------------

// Mirror MEDIA_DIR = join(handler __dirname, '..', '..', 'media').
const MEDIA_DIR = join(import.meta.dir, '..', '..', 'media');

interface CapturedRes {
  status?: number;
  headers?: Record<string, string>;
  writeHead(status: number, headers?: Record<string, string>): CapturedRes;
  end(data?: unknown): void;
}

function mockRes(): CapturedRes {
  const res: CapturedRes = {
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
      return res;
    },
    end() {},
  };
  return res;
}

function writeMediaFixture(id: string, ext: string, mimeType: string, filename: string, body: string): void {
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
  writeFileSync(join(MEDIA_DIR, `${id}${ext}`), body);
  writeFileSync(
    join(MEDIA_DIR, `${id}.json`),
    JSON.stringify({ mediaId: id, filename, mimeType, size: body.length, uploadedAt: new Date().toISOString() }),
  );
}

// hex-only id so it matches the /media/([a-f0-9-]+) route regex
const fixtures: string[] = [];
function newId(): string {
  const id = `deadbeef-0000-4000-8000-${(1e11 + fixtures.length).toString(16).padStart(12, '0')}`;
  fixtures.push(id);
  return id;
}

afterEach(() => {
  for (const id of fixtures.splice(0)) {
    for (const suffix of ['.json', '.svg', '.jpg']) {
      const p = join(MEDIA_DIR, `${id}${suffix}`);
      if (existsSync(p)) rmSync(p);
    }
  }
});

describe('HttpMediaHandler serving (A5)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: authService unused on the public GET path
  const handler = new HttpMediaHandler({} as any);

  it('serves an uploaded SVG as attachment + nosniff (blocks stored XSS)', async () => {
    const id = newId();
    writeMediaFixture(id, '.svg', 'image/svg+xml', 'pwn.svg', '<svg onload="alert(1)"><script>alert(1)</script></svg>');
    const res = mockRes();
    // biome-ignore lint/suspicious/noExplicitAny: minimal req stub
    const handled = await handler.handleRoute({ method: 'GET' } as any, res as any, `/media/${id}`);
    expect(handled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers?.['Content-Disposition']).toStartWith('attachment;');
    expect(res.headers?.['X-Content-Type-Options']).toBe('nosniff');
  });

  it('serves a benign image inline + nosniff (rendering preserved)', async () => {
    const id = newId();
    writeMediaFixture(id, '.jpg', 'image/jpeg', 'cat.jpg', 'JFIF-bytes');
    const res = mockRes();
    // biome-ignore lint/suspicious/noExplicitAny: minimal req stub
    await handler.handleRoute({ method: 'GET' } as any, res as any, `/media/${id}`);
    expect(res.headers?.['Content-Disposition']).toStartWith('inline;');
    expect(res.headers?.['X-Content-Type-Options']).toBe('nosniff');
  });

  it('sanitizes a header-injecting filename in the served Content-Disposition', async () => {
    const id = newId();
    writeMediaFixture(id, '.jpg', 'image/jpeg', 'a"\r\nSet-Cookie: b.jpg', 'JFIF-bytes');
    const res = mockRes();
    // biome-ignore lint/suspicious/noExplicitAny: minimal req stub
    await handler.handleRoute({ method: 'GET' } as any, res as any, `/media/${id}`);
    const cd = res.headers?.['Content-Disposition'] ?? '';
    // Security invariant: no CR/LF (response splitting) and no quote that closes
    // the filename value early. The delimiting quotes are the only two allowed.
    expect(cd).not.toContain('\r');
    expect(cd).not.toContain('\n');
    expect(cd).toMatch(/^inline; filename="[^"]*"$/);
  });
});

// ---------------------------------------------------------------------------
// 3. /uploads/ serving — the third sink (advisor catch)
// ---------------------------------------------------------------------------
// handleUploadedFile spreads MIME_TYPES (svg/xml/html/js) into its type map, and
// image/svg+xml is an ALLOWED upload type — so an uploaded .svg would otherwise
// be served inline: the same Stored XSS as media/static, by a third door.

describe('handleUploadedFile serving (A5, third sink)', () => {
  const uploadFixtures: string[] = [];

  afterEach(() => {
    for (const name of uploadFixtures.splice(0)) {
      const p = join(UPLOADS_DIR, name);
      if (existsSync(p)) rmSync(p);
    }
  });

  function writeUpload(name: string, body: string): void {
    if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });
    writeFileSync(join(UPLOADS_DIR, name), body);
    uploadFixtures.push(name);
  }

  it('serves an uploaded SVG as attachment + nosniff (live sink: svg is upload-allowed)', async () => {
    writeUpload('pwn.svg', '<svg><script>alert(1)</script></svg>');
    const res = mockRes();
    // biome-ignore lint/suspicious/noExplicitAny: minimal req stub
    await handleUploadedFile({} as any, res as any, '/uploads/pwn.svg');
    expect(res.status).toBe(200);
    expect(res.headers?.['Content-Disposition']).toStartWith('attachment;');
    expect(res.headers?.['X-Content-Type-Options']).toBe('nosniff');
  });

  it('serves a voice note (audio) inline + nosniff (no regression)', async () => {
    writeUpload('note.mp3', 'ID3-bytes');
    const res = mockRes();
    // biome-ignore lint/suspicious/noExplicitAny: minimal req stub
    await handleUploadedFile({} as any, res as any, '/uploads/note.mp3');
    expect(res.status).toBe(200);
    // audio is not a force-attach type → no attachment Content-Disposition
    expect(res.headers?.['Content-Disposition']).toBeUndefined();
    expect(res.headers?.['X-Content-Type-Options']).toBe('nosniff');
  });
});
