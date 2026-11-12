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
  applyInlineSafetyHeaders,
  buildFrameAncestorsDirective,
  FORCE_ATTACHMENT_TYPES,
  normalizeMediaType,
  sanitizeContentDispositionFilename,
  withTextCharset,
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

describe('withTextCharset', () => {
  it('appends charset=utf-8 to a text/* type lacking one (the mojibake bug)', () => {
    for (const t of ['text/markdown', 'text/plain', 'text/csv', 'text/html', 'text/css']) {
      expect(withTextCharset(t)).toBe(`${t}; charset=utf-8`);
    }
  });

  it('preserves an explicit charset (never doubled, never overridden)', () => {
    expect(withTextCharset('text/plain; charset=iso-8859-1')).toBe('text/plain; charset=iso-8859-1');
    expect(withTextCharset('TEXT/PLAIN; Charset=UTF-8')).toBe('TEXT/PLAIN; Charset=UTF-8');
  });

  it('passes non-text types through unchanged', () => {
    for (const t of ['image/jpeg', 'application/json', 'application/pdf', 'audio/mpeg']) {
      expect(withTextCharset(t)).toBe(t);
    }
  });

  it('tolerates empty input', () => {
    expect(withTextCharset('')).toBe('');
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
// 1b. Inline-serving helpers (security F1 — /objects and /share containment)
// ---------------------------------------------------------------------------

describe('buildFrameAncestorsDirective (F1)', () => {
  it("always includes 'self' plus the allowlisted app origins", () => {
    expect(buildFrameAncestorsDirective(['https://os.teros.ai', 'https://raw-os.teros.ai'])).toBe(
      "frame-ancestors 'self' https://os.teros.ai https://raw-os.teros.ai",
    );
  });

  it('dedupes and drops empty entries', () => {
    expect(buildFrameAncestorsDirective(['https://os.teros.ai', 'https://os.teros.ai', '', '  '])).toBe(
      "frame-ancestors 'self' https://os.teros.ai",
    );
  });

  it("degrades a '*' allowlist to 'self' only — never re-opens framing to the whole web", () => {
    expect(buildFrameAncestorsDirective(['*'])).toBe("frame-ancestors 'self'");
    expect(buildFrameAncestorsDirective(['*', 'https://os.teros.ai'])).toBe(
      "frame-ancestors 'self' https://os.teros.ai",
    );
  });

  it('an empty allowlist still allows same-origin framing', () => {
    expect(buildFrameAncestorsDirective([])).toBe("frame-ancestors 'self'");
  });
});

describe('applyInlineSafetyHeaders (F1)', () => {
  const FA = "frame-ancestors 'self' https://os.teros.ai";

  it('HTML gets the sandbox CSP: allow-scripts, NEVER allow-same-origin, plus frame-ancestors', () => {
    const h = applyInlineSafetyHeaders({ 'Content-Type': 'text/html' }, 'text/html', FA);
    expect(h['Content-Security-Policy']).toBe("sandbox allow-scripts; frame-ancestors 'self' https://os.teros.ai");
    expect(h['Content-Security-Policy']).toContain('allow-scripts');
    expect(h['Content-Security-Policy']).not.toContain('allow-same-origin');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

  it('SVG gets the sandbox CSP (the other browser-executable type served inline)', () => {
    const h = applyInlineSafetyHeaders({ 'Content-Type': 'image/svg+xml' }, 'image/svg+xml', FA);
    expect(h['Content-Security-Policy']).toContain('sandbox allow-scripts');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
  });

  it('every browser-executable type in FORCE_ATTACHMENT_TYPES gets the CSP — the exact sandboxed set', () => {
    for (const t of FORCE_ATTACHMENT_TYPES) {
      const h = applyInlineSafetyHeaders({ 'Content-Type': t }, t, FA);
      expect(h['Content-Security-Policy']).toContain('sandbox allow-scripts');
      expect(h['Content-Security-Policy']).toContain('frame-ancestors');
    }
  });

  it('benign types get NO CSP but DO get nosniff (a PNG must not be sniffed into HTML)', () => {
    for (const t of ['image/png', 'image/jpeg', 'application/pdf', 'text/plain', 'application/json', 'audio/mpeg', 'video/mp4', 'application/zip']) {
      const h = applyInlineSafetyHeaders({ 'Content-Type': t }, t, FA);
      expect(h['Content-Security-Policy']).toBeUndefined();
      expect(h['X-Content-Type-Options']).toBe('nosniff');
    }
  });

  it('a crafted mimeType with params/case cannot evade the sandbox set', () => {
    for (const t of ['text/html; charset=utf-8', 'TEXT/HTML', '  image/svg+xml ', 'image/svg+xml;x=1']) {
      const h = applyInlineSafetyHeaders({ 'Content-Type': t }, t, FA);
      expect(h['Content-Security-Policy']).toContain('sandbox allow-scripts');
    }
  });

  it('keeps the caller\'s Content-Disposition (inline serving is the point — no attachment override)', () => {
    const h = applyInlineSafetyHeaders(
      { 'Content-Type': 'text/html', 'Content-Disposition': 'inline; filename="deliverable.html"' },
      'text/html',
      FA,
    );
    expect(h['Content-Disposition']).toBe('inline; filename="deliverable.html"');
  });

  it('appends charset=utf-8 to a text/* Content-Type lacking one (same rule as the download path)', () => {
    const h = applyInlineSafetyHeaders({ 'Content-Type': 'text/html' }, 'text/html', FA);
    expect(h['Content-Type']).toBe('text/html; charset=utf-8');
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
    for (const suffix of ['.json', '.svg', '.jpg', '.md', '.txt', '.csv']) {
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

  it('serves text files with charset=utf-8 so non-ASCII does not mojibake (the fb_9fc7413b9cc7c59d bug)', async () => {
    // Before the fix the handler answered `Content-Type: text/markdown` with no
    // charset. RFC 9110 defines no default charset for text/*, so Chromium
    // guessed windows-1252 and rendered `situaciÃ³n` for UTF-8 `situación`.
    const cases: Array<[ext: string, mimeType: string, filename: string]> = [
      ['.md', 'text/markdown', 'reporte-situacion.md'],
      ['.txt', 'text/plain', 'notas-acción.txt'],
      ['.csv', 'text/csv', 'datos-polarización.csv'],
    ];
    for (const [ext, mimeType, filename] of cases) {
      const id = newId();
      writeMediaFixture(id, ext, mimeType, filename, 'situación — «Polarización» año 2026');
      const res = mockRes();
      // biome-ignore lint/suspicious/noExplicitAny: minimal req stub
      await handler.handleRoute({ method: 'GET' } as any, res as any, `/media/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers?.['Content-Type']).toBe(`${mimeType}; charset=utf-8`);
    }
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

describe('HttpMediaHandler text charset (fb_9fc7413b9cc7c59d)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: authService unused on the public GET path
  const handler = new HttpMediaHandler({} as any);

  it('serves text files with charset=utf-8 so non-ASCII does not mojibake', async () => {
    // Before the fix the handler answered `Content-Type: text/markdown` with no
    // charset. RFC 9110 defines no default charset for text/*, so Chromium
    // guessed windows-1252 and rendered `situaciÃ³n` for UTF-8 `situación`.
    const cases: Array<[ext: string, mimeType: string, filename: string]> = [
      ['.md', 'text/markdown', 'reporte-situacion.md'],
      ['.txt', 'text/plain', 'notas-acción.txt'],
      ['.csv', 'text/csv', 'datos-polarización.csv'],
    ];
    for (const [ext, mimeType, filename] of cases) {
      const id = newId();
      writeMediaFixture(id, ext, mimeType, filename, 'situación — «Polarización» año 2026');
      const res = mockRes();
      // biome-ignore lint/suspicious/noExplicitAny: minimal req stub
      await handler.handleRoute({ method: 'GET' } as any, res as any, `/media/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers?.['Content-Type']).toBe(`${mimeType}; charset=utf-8`);
    }
  });

  it('keeps non-text media Content-Type untouched (no charset appended)', async () => {
    const id = newId();
    writeMediaFixture(id, '.jpg', 'image/jpeg', 'cat.jpg', 'JFIF-bytes');
    const res = mockRes();
    // biome-ignore lint/suspicious/noExplicitAny: minimal req stub
    await handler.handleRoute({ method: 'GET' } as any, res as any, `/media/${id}`);
    expect(res.headers?.['Content-Type']).toBe('image/jpeg');
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
