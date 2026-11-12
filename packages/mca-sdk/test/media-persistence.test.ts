/**
 * Tests for media-persistence helpers (WS1b — objects-first standard).
 *
 * Mocks `ctx.objects` (ObjectStorage) and `fetch` via the `fetchImpl`
 * injection seam — no real network, no global leak.
 */
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_MAX_MEDIA_SIZE,
  isExternalMediaUrl,
  type MediaPersistenceContext,
  persistExternalMedia,
  persistExternalMediaOutput,
} from '../src/media-persistence';
import type { ObjectPutResult, ObjectStorage } from '../src/types';

// =============================================================================
// Test doubles
// =============================================================================

interface PutCall {
  data: Buffer;
  contentType: string;
  metadata?: Record<string, string>;
}

function makeMockObjects(): { objects: ObjectStorage; calls: PutCall[] } {
  const calls: PutCall[] = [];
  const objects: ObjectStorage = {
    async put(data, contentType, metadata): Promise<ObjectPutResult> {
      calls.push({ data, contentType, metadata });
      const objectId = `obj_${calls.length}`;
      return {
        success: true,
        objectId,
        url: `https://objects.teros.local/${objectId}`,
      };
    },
    async get() {
      return { success: false, data: null, error: 'not implemented' };
    },
    async delete() {
      return { success: true };
    },
    async list() {
      return { success: true, objects: [] };
    },
  };
  return { objects, calls };
}

function makeCtx(objects: ObjectStorage): MediaPersistenceContext {
  return { objects };
}

/** Build a fetch mock. `head`/`get` receive the URL and return a Response. */
function makeFetchMock(handlers: {
  head?: (url: string) => Response | Promise<Response>;
  get?: (url: string) => Response | Promise<Response>;
}): typeof fetch {
  return (async (url: any, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'HEAD' && handlers.head) return handlers.head(String(url));
    if (method === 'GET' && handlers.get) return handlers.get(String(url));
    throw new Error(`Unexpected fetch ${method} ${url}`);
  }) as typeof fetch;
}

function okHead(contentLength: number, contentType = 'image/png'): Response {
  return new Response(null, {
    status: 200,
    headers: {
      'content-length': String(contentLength),
      'content-type': contentType,
    },
  });
}

function okGet(body: string | Uint8Array, contentType = 'image/png'): Response {
  const buf = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return new Response(buf, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

// =============================================================================
// isExternalMediaUrl
// =============================================================================

describe('isExternalMediaUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isExternalMediaUrl('https://replicate.delivery/x.png')).toBe(true);
    expect(isExternalMediaUrl('http://example.com/a.mp3')).toBe(true);
  });

  it('rejects non-URL strings', () => {
    expect(isExternalMediaUrl('data:image/png;base64,xxx')).toBe(false);
    expect(isExternalMediaUrl('hello world')).toBe(false);
    expect(isExternalMediaUrl('ftp://example.com/x')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isExternalMediaUrl(null)).toBe(false);
    expect(isExternalMediaUrl(undefined)).toBe(false);
    expect(isExternalMediaUrl(123)).toBe(false);
    expect(isExternalMediaUrl({ url: 'https://x' })).toBe(false);
  });
});

// =============================================================================
// persistExternalMedia
// =============================================================================

describe('persistExternalMedia', () => {
  it('downloads and persists a small file', async () => {
    const { objects, calls } = makeMockObjects();
    const fetchImpl = makeFetchMock({
      head: () => okHead(1024),
      get: () => okGet('fake-image-bytes', 'image/png'),
    });

    const result = await persistExternalMedia(
      'https://cdn.example.com/img.png',
      makeCtx(objects),
      { source: 'replicate', metadata: { model: 'flux' }, fetchImpl },
    );

    expect(result.url).toBe('https://objects.teros.local/obj_1');
    expect(result.objectId).toBe('obj_1');
    expect(result.warning).toBeUndefined();

    expect(calls.length).toBe(1);
    expect(calls[0].contentType).toBe('image/png');
    expect(calls[0].metadata?.source).toBe('replicate');
    expect(calls[0].metadata?.externalUrl).toBe('https://cdn.example.com/img.png');
    expect(calls[0].metadata?.model).toBe('flux');
  });

  it('returns warning and skips download when HEAD reports oversized file', async () => {
    const { objects, calls } = makeMockObjects();
    let getCalled = false;
    const fetchImpl = makeFetchMock({
      head: () => okHead(DEFAULT_MAX_MEDIA_SIZE + 1),
      get: () => {
        getCalled = true;
        return okGet('should-not-download');
      },
    });

    const result = await persistExternalMedia(
      'https://cdn.example.com/huge.mp4',
      makeCtx(objects),
      { fetchImpl },
    );

    expect(result.url).toBe('https://cdn.example.com/huge.mp4');
    expect(result.objectId).toBeNull();
    expect(result.warning).toContain('50MB');
    expect(getCalled).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('respects custom maxSizeBytes', async () => {
    const { objects } = makeMockObjects();
    const fetchImpl = makeFetchMock({
      head: () => okHead(2000),
      get: () => okGet('x'),
    });

    const result = await persistExternalMedia(
      'https://cdn.example.com/file.bin',
      makeCtx(objects),
      { maxSizeBytes: 1000, fetchImpl },
    );

    expect(result.objectId).toBeNull();
    expect(result.warning).toContain('1000B');
  });

  it('falls back to GET size check when HEAD fails', async () => {
    const { objects, calls } = makeMockObjects();
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD') throw new Error('HEAD not supported');
      return okGet('small-body', 'image/jpeg');
    }) as typeof fetch;

    const result = await persistExternalMedia(
      'https://cdn.example.com/img.jpg',
      makeCtx(objects),
      { fetchImpl },
    );

    expect(result.objectId).toBe('obj_1');
    expect(calls.length).toBe(1);
    expect(calls[0].contentType).toBe('image/jpeg');
  });

  it('rejects after GET if actual body exceeds limit (HEAD was wrong)', async () => {
    const { objects, calls } = makeMockObjects();
    const bigBody = new Uint8Array(2048).fill(65); // 2KB
    const fetchImpl = makeFetchMock({
      head: () => okHead(10), // HEAD lies — says tiny
      get: () => okGet(bigBody),
    });

    const result = await persistExternalMedia(
      'https://cdn.example.com/file.bin',
      makeCtx(objects),
      { maxSizeBytes: 1000, fetchImpl },
    );

    expect(result.objectId).toBeNull();
    expect(result.warning).toContain('1000B');
    expect(calls.length).toBe(0);
  });

  it('throws on GET non-2xx (media is gone — caller should fail)', async () => {
    const { objects, calls } = makeMockObjects();
    const fetchImpl = makeFetchMock({
      head: () => okHead(100),
      get: () => new Response('gone', { status: 410, statusText: 'Gone' }),
    });

    await expect(
      persistExternalMedia('https://cdn.example.com/expired.png', makeCtx(objects), {
        fetchImpl,
      }),
    ).rejects.toThrow('410');
    expect(calls.length).toBe(0);
  });

  it('uses defaultContentType when response has no content-type header', async () => {
    const { objects, calls } = makeMockObjects();
    const fetchImpl = makeFetchMock({
      head: () => okHead(100),
      get: () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          // no content-type header
        }),
    });

    await persistExternalMedia('https://cdn.example.com/x', makeCtx(objects), {
      defaultContentType: 'video/mp4',
      fetchImpl,
    });

    expect(calls[0].contentType).toBe('video/mp4');
  });

  it('uses "unknown" source when not provided', async () => {
    const { objects, calls } = makeMockObjects();
    const fetchImpl = makeFetchMock({
      head: () => okHead(100),
      get: () => okGet('x'),
    });

    await persistExternalMedia('https://cdn.example.com/x', makeCtx(objects), {
      fetchImpl,
    });

    expect(calls[0].metadata?.source).toBe('unknown');
  });
});

// =============================================================================
// persistExternalMediaOutput
// =============================================================================

describe('persistExternalMediaOutput', () => {
  it('persists a single URL string', async () => {
    const { objects, calls } = makeMockObjects();
    const fetchImpl = makeFetchMock({
      head: () => okHead(100),
      get: () => okGet('x', 'image/png'),
    });

    const result = await persistExternalMediaOutput(
      'https://cdn.example.com/a.png',
      makeCtx(objects),
      { source: 'replicate', fetchImpl },
    );

    expect(result.output).toBe('https://objects.teros.local/obj_1');
    expect(result.objectIds).toEqual(['obj_1']);
    expect(result.warnings).toEqual([]);
    expect(result.externalUrls).toEqual(['https://cdn.example.com/a.png']);
    expect(result.internalUrls).toEqual(['https://objects.teros.local/obj_1']);
    expect(calls.length).toBe(1);
  });

  it('persists an array of URLs, keeping non-URL items as-is', async () => {
    const { objects, calls } = makeMockObjects();
    const fetchImpl = makeFetchMock({
      head: () => okHead(100),
      get: () => okGet('x', 'image/png'),
    });

    const result = await persistExternalMediaOutput(
      [
        'https://cdn.example.com/a.png',
        'plain text item',
        42,
        'https://cdn.example.com/b.png',
      ],
      makeCtx(objects),
      { fetchImpl },
    );

    expect(result.output).toEqual([
      'https://objects.teros.local/obj_1',
      'plain text item',
      42,
      'https://objects.teros.local/obj_2',
    ]);
    expect(result.objectIds).toEqual(['obj_1', 'obj_2']);
    expect(result.externalUrls).toEqual([
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/b.png',
    ]);
    expect(result.internalUrls).toEqual([
      'https://objects.teros.local/obj_1',
      'https://objects.teros.local/obj_2',
    ]);
    expect(calls.length).toBe(2);
  });

  it('returns non-URL output unchanged', async () => {
    const { objects, calls } = makeMockObjects();
    const fetchImpl = makeFetchMock({}); // should never be called

    const result = await persistExternalMediaOutput(
      'just some text output',
      makeCtx(objects),
      { fetchImpl },
    );

    expect(result.output).toBe('just some text output');
    expect(result.objectIds).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it('returns structured objects unchanged', async () => {
    const { objects, calls } = makeMockObjects();
    const fetchImpl = makeFetchMock({});

    const structured = { text: 'hello', score: 0.95 };
    const result = await persistExternalMediaOutput(structured, makeCtx(objects), {
      fetchImpl,
    });

    expect(result.output).toBe(structured);
    expect(result.objectIds).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it('collects warnings for oversized items in an array', async () => {
    const { objects, calls } = makeMockObjects();
    let headCount = 0;
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'HEAD') {
        headCount++;
        // First URL is oversized, second is fine
        return headCount === 1 ? okHead(DEFAULT_MAX_MEDIA_SIZE + 1) : okHead(100);
      }
      return okGet('small', 'image/png');
    }) as typeof fetch;

    const result = await persistExternalMediaOutput(
      ['https://cdn.example.com/big.mp4', 'https://cdn.example.com/small.png'],
      makeCtx(objects),
      { fetchImpl },
    );

    const out = result.output as string[];
    expect(out[0]).toBe('https://cdn.example.com/big.mp4'); // oversized → original
    expect(out[1]).toBe('https://objects.teros.local/obj_1'); // persisted
    expect(result.objectIds).toEqual(['obj_1']);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('50MB');
    expect(calls.length).toBe(1);
  });
});
