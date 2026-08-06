import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fetchContext7Json, fetchContext7Raw } from '../../src/lib/client';
import {
  Context7AuthError,
  Context7Error,
  Context7NotFoundError,
  Context7RateLimitError,
} from '../../src/lib/errors';

const originalFetch = globalThis.fetch;

describe('fetchContext7Raw', () => {
  let calls: { url: string; init?: RequestInit }[];

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return responder(url, init);
    }) as typeof fetch;
  }

  test('attaches Bearer header when apiKey present', async () => {
    stubFetch(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await fetchContext7Raw('/v2/libs/search', { apiKey: 'ctx7sk-abc', searchParams: { libraryName: 'x' } });
    expect(calls[0].init?.headers).toBeDefined();
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ctx7sk-abc');
  });

  test('omits Authorization header when no apiKey', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    await fetchContext7Raw('/v2/libs/search', { searchParams: { libraryName: 'x' } });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  test('throws Context7AuthError on 401', async () => {
    stubFetch(() => new Response('Unauthorized', { status: 401 }));
    await expect(fetchContext7Raw('/v2/libs/search')).rejects.toBeInstanceOf(Context7AuthError);
  });

  test('throws Context7NotFoundError on 404', async () => {
    stubFetch(() => new Response('Not Found', { status: 404 }));
    await expect(fetchContext7Raw('/v2/libs/search')).rejects.toBeInstanceOf(Context7NotFoundError);
  });

  test('throws Context7Error with status on other 4xx', async () => {
    stubFetch(() => new Response('Bad Request', { status: 400 }));
    await expect(fetchContext7Raw('/v2/libs/search')).rejects.toBeInstanceOf(Context7Error);
  });

  test('does not retry on 401 (auth fail is permanent)', async () => {
    stubFetch(() => new Response('Unauthorized', { status: 401 }));
    await fetchContext7Raw('/v2/libs/search').catch(() => {});
    expect(calls).toHaveLength(1);
  });
});

describe('fetchContext7Json', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('parses JSON body', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ results: [{ id: '/x/y' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const out = await fetchContext7Json<{ results: { id: string }[] }>('/v2/libs/search');
    expect(out.results[0].id).toBe('/x/y');
  });

  test('throws on non-JSON body', async () => {
    globalThis.fetch = (async () =>
      new Response('plain text', { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch;
    await expect(fetchContext7Json('/v2/libs/search')).rejects.toBeInstanceOf(Context7Error);
  });
});

describe('Context7RateLimitError', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('thrown on 429', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('rate limited', { status: 429 });
    }) as typeof fetch;
    await expect(fetchContext7Raw('/v2/libs/search')).rejects.toBeInstanceOf(Context7RateLimitError);
    expect(calls).toBeGreaterThan(1);
  });
});
