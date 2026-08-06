import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildHunterUrl,
  HUNTER_BASE_URL,
  hunterGet,
  hunterGetEnvelope,
  parseRetryAfter,
} from '../../src/lib/hunter-client';
import { classifyHunterError, extractHunterMessage, HunterError } from '../../src/lib/errors';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('buildHunterUrl', () => {
  test('appends search params, strips empty/undefined, and NEVER adds api_key', () => {
    const url = buildHunterUrl('/domain-search', {
      domain: 'stripe.com',
      limit: 10,
      offset: undefined,
      empty: '',
    });
    expect(url.origin + url.pathname).toBe(`${HUNTER_BASE_URL}/domain-search`);
    expect(url.searchParams.get('domain')).toBe('stripe.com');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.has('offset')).toBe(false);
    expect(url.searchParams.has('empty')).toBe(false);
    // M5 (CWE-598): the key must never travel in the URL.
    expect(url.searchParams.has('api_key')).toBe(false);
    expect(url.toString()).not.toContain('api_key');
  });

  test('numbers are serialized as strings', () => {
    const url = buildHunterUrl('/x', { offset: 0 });
    expect(url.searchParams.get('offset')).toBe('0');
  });
});

describe('parseRetryAfter', () => {
  test('delay-seconds → milliseconds', () => {
    expect(parseRetryAfter('2')).toBe(2000);
  });

  test('clamps a large delay-seconds to the 30s cap', () => {
    expect(parseRetryAfter('3600')).toBe(30_000);
  });

  test('absent / empty / unparseable → undefined', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('whenever')).toBeUndefined();
  });

  test('negative delay → undefined', () => {
    expect(parseRetryAfter('-5')).toBeUndefined();
  });

  test('HTTP-date in the future → clamped to the cap', () => {
    const future = new Date(Date.now() + 3_600_000).toUTCString();
    expect(parseRetryAfter(future)).toBe(30_000);
  });

  test('HTTP-date already in the past → 0', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });
});

describe('extractHunterMessage', () => {
  test('reads details + id from the Hunter error envelope', () => {
    const body = JSON.stringify({ errors: [{ id: 'usage_limit_reached', code: 429, details: 'Too much' }] });
    expect(extractHunterMessage(body, 429)).toEqual({ id: 'usage_limit_reached', message: 'Too much' });
  });

  test('falls back to truncated raw body when not JSON', () => {
    expect(extractHunterMessage('boom', 500)).toEqual({ message: 'boom' });
  });

  test('falls back to a status message when body is empty', () => {
    expect(extractHunterMessage('', 502)).toEqual({ message: 'Hunter API returned HTTP 502' });
  });
});

describe('classifyHunterError', () => {
  const body = (id: string, details: string) => JSON.stringify({ errors: [{ id, details }] });

  test('401 -> AUTH_INVALID with [CODE] prefix and preserved upstream', () => {
    const err = classifyHunterError(401, body('wrong_auth', 'Invalid API key'));
    expect(err).toBeInstanceOf(HunterError);
    expect(err.code).toBe('AUTH_INVALID');
    expect(err.httpStatus).toBe(401);
    expect(err.upstreamMessage).toBe('Invalid API key');
    expect(err.message).toBe('[AUTH_INVALID] Invalid API key');
  });

  test('403 -> RATE_LIMITED (Hunter uses 403 for rate limiting)', () => {
    const err = classifyHunterError(403, body('rate_limit', 'Too fast'));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.httpStatus).toBe(403);
  });

  test('429 -> QUOTA_EXCEEDED directly, even when the body has no usage keyword', () => {
    // The old heuristic mapped this body ("Slow down") to RATE_LIMITED; the API
    // reality is that 429 is ALWAYS the monthly usage/credit limit.
    const err = classifyHunterError(429, body('too_many_requests', 'Slow down'));
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(err.httpStatus).toBe(429);
  });

  test('429 usage_limit_reached -> QUOTA_EXCEEDED', () => {
    expect(classifyHunterError(429, body('usage_limit_reached', 'Monthly limit')).code).toBe(
      'QUOTA_EXCEEDED',
    );
  });

  test('400 and 422 -> BAD_REQUEST', () => {
    expect(classifyHunterError(400, body('bad', 'nope')).code).toBe('BAD_REQUEST');
    expect(classifyHunterError(422, body('bad', 'nope')).code).toBe('BAD_REQUEST');
  });

  test('404 -> NOT_FOUND', () => {
    expect(classifyHunterError(404, body('nf', 'gone')).code).toBe('NOT_FOUND');
  });

  test('500 -> DEPENDENCY_UNAVAILABLE', () => {
    expect(classifyHunterError(500, body('srv', 'kaboom')).code).toBe('DEPENDENCY_UNAVAILABLE');
  });
});

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('hunterGet', () => {
  test('returns the data payload and sends the key in the X-API-KEY header, NOT the URL', async () => {
    let seenUrl = '';
    let seenHeaders = new Headers();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      return jsonResponse({ data: { domain: 'stripe.com' }, meta: {} });
    }) as typeof fetch;

    const data = await hunterGet<{ domain: string }>('/domain-search', {
      apiKey: 'sk-xyz',
      searchParams: { domain: 'stripe.com' },
    });

    expect(data).toEqual({ domain: 'stripe.com' });
    expect(seenUrl).toContain('domain=stripe.com');
    // M5: the secret is in the header, absent from the URL.
    expect(seenUrl).not.toContain('sk-xyz');
    expect(seenUrl).not.toContain('api_key');
    expect(seenHeaders.get('x-api-key')).toBe('sk-xyz');
  });

  test('hunterGetEnvelope surfaces meta alongside data (M4 plumbing)', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ data: { emails: [] }, meta: { results: 87, limit: 10, offset: 0 } })) as typeof fetch;

    const env = await hunterGetEnvelope<{ emails: unknown[] }>('/domain-search', { apiKey: 'k' });
    expect(env.data).toEqual({ emails: [] });
    expect(env.meta).toEqual({ results: 87, limit: 10, offset: 0 });
  });

  test('does NOT retry on 401 (auth)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse({ errors: [{ id: 'wrong_auth', details: 'Invalid key' }] }, 401);
    }) as typeof fetch;

    await expect(
      hunterGet('/account', { apiKey: 'bad', _sleep: async () => {} }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    expect(calls).toBe(1);
  });

  test('retries a transient 403 rate-limit then succeeds', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls <= 2) {
        return jsonResponse({ errors: [{ id: 'rate_limit', details: 'Slow down' }] }, 403);
      }
      return jsonResponse({ data: { ok: true } });
    }) as typeof fetch;

    const data = await hunterGet<{ ok: boolean }>('/x', { apiKey: 'k', _sleep: async () => {} });
    expect(data).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  test('does NOT retry QUOTA_EXCEEDED (429)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse({ errors: [{ id: 'usage_limit_reached', details: 'Out of credits' }] }, 429);
    }) as typeof fetch;

    await expect(hunterGet('/x', { apiKey: 'k', _sleep: async () => {} })).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect(calls).toBe(1);
  });

  test('honors Retry-After clamped to 30s on a retryable 403', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse(
          { errors: [{ id: 'rate_limit', details: 'Slow down' }] },
          403,
          { 'retry-after': '3600' }, // 1h → must clamp to the 30s cap
        );
      }
      return jsonResponse({ data: { ok: true } });
    }) as typeof fetch;

    await hunterGet('/x', { apiKey: 'k', _sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps[0]).toBe(30_000);
  });

  test('202 (email-verifier still processing) polls the same endpoint then returns', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ data: {} }), { status: 202 });
      return jsonResponse({ data: { status: 'valid' } });
    }) as typeof fetch;

    const data = await hunterGet('/email-verifier', { apiKey: 'k', _sleep: async () => {} });
    expect(data).toEqual({ status: 'valid' });
    expect(calls).toBe(2);
  });

  test('202 that never settles → PENDING (not a bogus empty success)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: {} }), { status: 202 });
    }) as typeof fetch;

    await expect(
      hunterGet('/email-verifier', { apiKey: 'k', maxRetries: 1, _sleep: async () => {} }),
    ).rejects.toMatchObject({ code: 'PENDING' });
    expect(calls).toBe(2); // initial attempt + 1 poll
  });

  test('the request timeout fires even when the caller supplies its own signal (M1)', async () => {
    const callerSignal = new AbortController().signal; // real, never aborts
    let abortedByClient = false;
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (!sig) return; // old bug: caller signal swallowed the timeout → hang
        sig.addEventListener('abort', () => {
          abortedByClient = true;
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      })) as typeof fetch;

    await expect(
      hunterGet('/x', {
        apiKey: 'k',
        signal: callerSignal,
        timeoutMs: 10,
        maxRetries: 0,
        _sleep: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
    expect(abortedByClient).toBe(true);
  }, 1000);

  test('caller cancellation (AbortError) is propagated WITHOUT retry', async () => {
    const ac = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      ac.abort(); // the caller cancels mid-flight
      throw new DOMException('The operation was aborted', 'AbortError');
    }) as typeof fetch;

    await expect(
      hunterGet('/x', { apiKey: 'k', signal: ac.signal, maxRetries: 3, _sleep: async () => {} }),
    ).rejects.toBeDefined();
    expect(calls).toBe(1); // no retry on cancellation
  });

  test('throws DEPENDENCY_UNAVAILABLE on a non-JSON 200 body', async () => {
    globalThis.fetch = (async () => new Response('<html>nope</html>', { status: 200 })) as typeof fetch;
    await expect(hunterGet('/x', { apiKey: 'k', maxRetries: 0 })).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
  });
});
