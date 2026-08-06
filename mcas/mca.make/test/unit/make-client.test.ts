import { describe, expect, test } from 'bun:test';
import { MakeError } from '../../src/lib/errors';
import {
  accountApiJson,
  accountApiRaw,
  type FetchLike,
  normalizeRegion,
  parseRetryAfterMs,
  serializeWebhookPayload,
  triggerWebhook,
} from '../../src/lib/make-client';

interface Call {
  url: string;
  init?: RequestInit;
}

/** Build a FetchLike that records calls and replies via `responder`. */
function recorder(responder: (call: Call) => Response): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input.href;
    const call: Call = { url, init };
    calls.push(call);
    return responder(call);
  };
  return { fetchImpl, calls };
}

/**
 * A fetch mock that honours `init.redirect` like the REAL fetch does:
 *   - 3xx + redirect:'error'  → throws TypeError (terminal — never followed)
 *   - 3xx + redirect:'follow' → follows the Location header (records a 2nd call)
 * This lets a test PROVE the SSRF guard: without `redirect:'error'`, a hostile
 * webhook replying `307 Location: http://169.254.169.254/...` would be followed
 * (POST + body) to the internal host. The internal host returns a "secret" body
 * so a regression is unmistakable.
 */
const INTERNAL_HOST_URL = 'http://169.254.169.254/latest/meta-data/';
function redirectAwareFetch(firstHostPrefix: string): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input.href;
    calls.push({ url, init });
    if (url.startsWith(firstHostPrefix)) {
      // The first hop (the validated make.com host) replies with a redirect.
      if (init?.redirect === 'error') throw new TypeError('unexpected redirect');
      // redirect:'follow' (or unset) → follow to the Location host.
      return fetchImpl(INTERNAL_HOST_URL, init);
    }
    // Only reached if the redirect was (wrongly) followed.
    return new Response('{"imds":"secret-credentials"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

function headerOf(init: RequestInit | undefined, key: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[key];
}

/** Catch a MakeError or fail. */
async function rejectedWith(promise: Promise<unknown>): Promise<MakeError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof MakeError) return e;
    throw e;
  }
  throw new Error('expected the promise to reject with a MakeError');
}

// ─── serializeWebhookPayload ────────────────────────────────────────────────

describe('serializeWebhookPayload', () => {
  test('object → application/json with exact JSON body', () => {
    const { body, contentType } = serializeWebhookPayload({ hello: 'world', n: 1 });
    expect(contentType).toBe('application/json');
    expect(body).toBe(JSON.stringify({ hello: 'world', n: 1 }));
  });

  test('array → application/json', () => {
    const { body, contentType } = serializeWebhookPayload([1, 2, 3]);
    expect(contentType).toBe('application/json');
    expect(body).toBe('[1,2,3]');
  });

  test('JSON string → forwarded as application/json (trimmed)', () => {
    const { body, contentType } = serializeWebhookPayload('  {"a":1}  ');
    expect(contentType).toBe('application/json');
    expect(body).toBe('{"a":1}');
  });

  test('non-JSON string → text/plain raw', () => {
    const { body, contentType } = serializeWebhookPayload('plain hello');
    expect(contentType).toBe('text/plain');
    expect(body).toBe('plain hello');
  });

  test('empty string → empty text/plain', () => {
    const { body, contentType } = serializeWebhookPayload('');
    expect(contentType).toBe('text/plain');
    expect(body).toBe('');
  });
});

// ─── triggerWebhook ─────────────────────────────────────────────────────────

describe('triggerWebhook — POST construction', () => {
  test('POSTs the exact payload to the validated URL with application/json', async () => {
    const { fetchImpl, calls } = recorder(
      () => new Response('Accepted', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );

    const res = await triggerWebhook(
      'https://hook.eu1.make.com/tok',
      { foo: 'bar' },
      { fetchImpl },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hook.eu1.make.com/tok');
    expect(calls[0].init?.method).toBe('POST');
    expect(headerOf(calls[0].init, 'content-type')).toBe('application/json');
    expect(calls[0].init?.body).toBe(JSON.stringify({ foo: 'bar' }));

    expect(res).toEqual({
      delivered: true,
      statusCode: 200,
      webhookHost: 'hook.eu1.make.com',
      region: 'eu1',
      responseType: 'text',
      response: 'Accepted',
    });
  });

  test('parses a JSON response body and reports the region', async () => {
    const { fetchImpl } = recorder(
      () =>
        new Response('{"ok":true,"id":7}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const res = await triggerWebhook('https://hook.us1.make.com/t', { a: 1 }, { fetchImpl });
    expect(res.responseType).toBe('json');
    expect(res.response).toEqual({ ok: true, id: 7 });
    expect(res.region).toBe('us1');
    expect(res.webhookHost).toBe('hook.us1.make.com');
  });

  test('rejects a non-Make host BEFORE any fetch (SSRF guard, no network)', async () => {
    let fetched = false;
    const fetchImpl: FetchLike = async () => {
      fetched = true;
      return new Response('x');
    };

    const err = await rejectedWith(
      triggerWebhook('https://evil.com/x', { a: 1 }, { fetchImpl }),
    );
    expect(err.code).toBe('BAD_REQUEST');
    expect(fetched).toBe(false);
  });

  test('does NOT leak the tokenized webhook URL in the error message (redaction)', async () => {
    const { fetchImpl } = recorder(() => new Response('no scenario listening', { status: 400 }));

    const err = await rejectedWith(
      triggerWebhook('https://hook.eu1.make.com/SUPER-SECRET-TOKEN', { a: 1 }, { fetchImpl }),
    );
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).not.toContain('SUPER-SECRET-TOKEN');
    expect(err.message).toContain('hook.eu1.make.com');
  });

  test('maps a 5xx webhook response to DEPENDENCY_UNAVAILABLE without leaking the token', async () => {
    const { fetchImpl } = recorder(() => new Response('upstream boom', { status: 502 }));

    const err = await rejectedWith(
      triggerWebhook('https://hook.eu1.make.com/SECRET-TOKEN', {}, { fetchImpl }),
    );
    expect(err.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(err.message).not.toContain('SECRET-TOKEN');
  });

  test('redacts the tokenized URL from a network error message (no token leak)', async () => {
    // A real fetch error can echo the full URL — INCLUDING the path token — in
    // its `.message`. This bites: the catch must scrub it, not append it raw.
    const fetchImpl: FetchLike = async () => {
      throw new Error(
        'request to https://hook.eu1.make.com/SECRET-TOKEN failed, reason: ECONNRESET',
      );
    };
    const err = await rejectedWith(
      triggerWebhook('https://hook.eu1.make.com/SECRET-TOKEN', {}, { fetchImpl }),
    );
    expect(err.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(err.message).not.toContain('SECRET-TOKEN');
    expect(err.message).toContain('hook.eu1.make.com');
  });

  test('redacts the tokenized URL if the webhook echoes it in a 4xx body', async () => {
    const { fetchImpl } = recorder(
      () =>
        new Response('no scenario listening at https://hook.eu1.make.com/SECRET-TOKEN', {
          status: 400,
        }),
    );
    const err = await rejectedWith(
      triggerWebhook('https://hook.eu1.make.com/SECRET-TOKEN', {}, { fetchImpl }),
    );
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).not.toContain('SECRET-TOKEN');
    expect(err.message).toContain('hook.eu1.make.com');
  });

  // ─── C1: SSRF via redirect-follow ─────────────────────────────────────────
  test('C1: a 3xx redirect from the webhook is TERMINAL — never followed to the Location host', async () => {
    const { fetchImpl, calls } = redirectAwareFetch('https://hook.eu1.make.com/');

    const err = await rejectedWith(
      triggerWebhook('https://hook.eu1.make.com/tok', { a: 1 }, { fetchImpl }),
    );

    // redirect:'error' made fetch throw → surfaced as a dependency error.
    expect(err.code).toBe('DEPENDENCY_UNAVAILABLE');
    // Exactly one hop — the internal IMDS host was NEVER contacted.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hook.eu1.make.com/tok');
    expect(calls.some((c) => c.url.includes('169.254.169.254'))).toBe(false);
    // The option that enforces this is actually set on the request.
    expect(calls[0].init?.redirect).toBe('error');
  });
});

// ─── normalizeRegion ────────────────────────────────────────────────────────

describe('normalizeRegion', () => {
  test('defaults to eu1 when empty/absent', () => {
    expect(normalizeRegion(undefined)).toBe('eu1');
    expect(normalizeRegion(null)).toBe('eu1');
    expect(normalizeRegion('')).toBe('eu1');
    expect(normalizeRegion('   ')).toBe('eu1');
  });

  test('accepts known regions case-insensitively', () => {
    expect(normalizeRegion('US1')).toBe('us1');
    expect(normalizeRegion('eu2')).toBe('eu2');
    expect(normalizeRegion(' us2 ')).toBe('us2');
  });

  test('throws [BAD_REQUEST] on an unknown region', () => {
    let err: MakeError | undefined;
    try {
      normalizeRegion('mars1');
    } catch (e) {
      err = e as MakeError;
    }
    expect(err?.code).toBe('BAD_REQUEST');
  });
});

// ─── accountApiJson ─────────────────────────────────────────────────────────

describe('accountApiJson — auth, URL, parsing', () => {
  test('GET sends Authorization: Token, builds the regional URL, and parses JSON', async () => {
    const { fetchImpl, calls } = recorder(
      () =>
        new Response('{"scenarios":[{"id":1,"name":"X"}]}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const out = await accountApiJson<{ scenarios: unknown[] }>('GET', '/scenarios', {
      apiKey: 'tok-123',
      region: 'eu1',
      searchParams: { teamId: '42' },
      fetchImpl,
    });

    expect(out).toEqual({ scenarios: [{ id: 1, name: 'X' }] });
    expect(calls[0].url).toBe('https://eu1.make.com/api/v2/scenarios?teamId=42');
    expect(headerOf(calls[0].init, 'authorization')).toBe('Token tok-123');
    expect(calls[0].init?.redirect).toBe('error'); // SSRF defense-in-depth
  });

  test('POST sends the JSON body + content-type and targets the right region', async () => {
    const { fetchImpl, calls } = recorder(
      () =>
        new Response('{"executionId":"e1"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const out = await accountApiJson<{ executionId: string }>('POST', '/scenarios/9/run', {
      apiKey: 't',
      region: 'us2',
      body: { responsive: true },
      fetchImpl,
    });

    expect(out).toEqual({ executionId: 'e1' });
    expect(calls[0].url).toBe('https://us2.make.com/api/v2/scenarios/9/run');
    expect(calls[0].init?.method).toBe('POST');
    expect(headerOf(calls[0].init, 'content-type')).toBe('application/json');
    expect(calls[0].init?.body).toBe(JSON.stringify({ responsive: true }));
    expect(calls[0].init?.redirect).toBe('error'); // SSRF defense-in-depth
  });
});

describe('accountApiJson — error mapping + retry semantics', () => {
  test('maps 401 to AUTH_INVALID and preserves the upstream message literally', async () => {
    const { fetchImpl } = recorder(
      () =>
        new Response('{"message":"Authorization token is invalid"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const err = await rejectedWith(
      accountApiJson('GET', '/scenarios', { apiKey: 'bad', region: 'eu1', fetchImpl }),
    );
    expect(err.code).toBe('AUTH_INVALID');
    expect(err.upstreamMessage).toBe('Authorization token is invalid');
    expect(err.message).toBe('[AUTH_INVALID] Authorization token is invalid');
  });

  test('maps 404 to NOT_FOUND', async () => {
    const { fetchImpl } = recorder(
      () => new Response('{"message":"Scenario not found"}', { status: 404 }),
    );
    const err = await rejectedWith(
      accountApiJson('GET', '/scenarios/999', { apiKey: 't', region: 'eu1', fetchImpl }),
    );
    expect(err.code).toBe('NOT_FOUND');
  });

  test('GET retries a transient 500 then succeeds', async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      if (n < 2) return new Response('boom', { status: 500 });
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const out = await accountApiJson<{ ok: boolean }>('GET', '/users/me', {
      apiKey: 't',
      region: 'eu1',
      retryDelayMs: 1,
      fetchImpl,
    });
    expect(out).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  test('GET retries a persistent 500 up to the cap, then throws DEPENDENCY_UNAVAILABLE', async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      return new Response('boom', { status: 500 });
    };

    const err = await rejectedWith(
      accountApiJson('GET', '/users/me', {
        apiKey: 't',
        region: 'eu1',
        retryDelayMs: 1,
        fetchImpl,
      }),
    );
    expect(err.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(n).toBe(3); // 1 initial + 2 retries
  });

  test('POST is NEVER retried (no idempotency key → would double-run)', async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      return new Response('boom', { status: 500 });
    };

    const err = await rejectedWith(
      accountApiJson('POST', '/scenarios/1/run', {
        apiKey: 't',
        region: 'eu1',
        body: {},
        retryDelayMs: 1,
        fetchImpl,
      }),
    );
    expect(err.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(n).toBe(1); // exactly one attempt
  });

  test('PATCH is NEVER retried (no idempotency key → could apply twice)', async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      return new Response('boom', { status: 500 });
    };

    const err = await rejectedWith(
      accountApiJson('PATCH', '/scenarios/1', {
        apiKey: 't',
        region: 'eu1',
        body: { name: 'x' },
        retryDelayMs: 1,
        fetchImpl,
      }),
    );
    expect(err.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(n).toBe(1);
  });

  test('DELETE is NEVER retried (no idempotency key → could delete twice)', async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      return new Response('boom', { status: 500 });
    };

    const err = await rejectedWith(
      accountApiJson('DELETE', '/scenarios/1', {
        apiKey: 't',
        region: 'eu1',
        retryDelayMs: 1,
        fetchImpl,
      }),
    );
    expect(err.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(n).toBe(1);
  });

  test('PATCH sends the JSON body and targets the right region', async () => {
    const { fetchImpl, calls } = recorder(
      () => new Response('{"id":1,"name":"x"}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const out = await accountApiJson<{ id: number; name: string }>('PATCH', '/scenarios/9', {
      apiKey: 't',
      region: 'us2',
      body: { name: 'x' },
      fetchImpl,
    });

    expect(out).toEqual({ id: 1, name: 'x' });
    expect(calls[0].url).toBe('https://us2.make.com/api/v2/scenarios/9');
    expect(calls[0].init?.method).toBe('PATCH');
    expect(headerOf(calls[0].init, 'content-type')).toBe('application/json');
    expect(calls[0].init?.body).toBe(JSON.stringify({ name: 'x' }));
  });

  test('DELETE sends no body and targets the right region', async () => {
    const { fetchImpl, calls } = recorder(() => new Response('', { status: 204 }));

    await accountApiJson<unknown>('DELETE', '/scenarios/9', {
      apiKey: 't',
      region: 'us2',
      fetchImpl,
    });

    expect(calls[0].url).toBe('https://us2.make.com/api/v2/scenarios/9');
    expect(calls[0].init?.method).toBe('DELETE');
    expect(calls[0].init?.body).toBeUndefined();
  });

  test('GET does NOT retry a 401 (permanent auth failure)', async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      return new Response('nope', { status: 401 });
    };

    await rejectedWith(
      accountApiJson('GET', '/scenarios', { apiKey: 'bad', region: 'eu1', retryDelayMs: 1, fetchImpl }),
    );
    expect(n).toBe(1);
  });

  test('GET honors Retry-After over the backoff base (429 → fast retry, then 200)', async () => {
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      if (n === 1) {
        return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const start = Date.now();
    const out = await accountApiJson<{ ok: boolean }>('GET', '/scenarios', {
      apiKey: 't',
      region: 'eu1',
      retryDelayMs: 5000, // a huge backoff base — Retry-After:0 MUST win, else this hangs ~5s
      fetchImpl,
    });

    expect(out).toEqual({ ok: true });
    expect(n).toBe(2);
    // BITES: if the code ignored Retry-After and used the 5s backoff, this fails.
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

// ─── accountApiRaw — transport hardening (timeout, error wrap, redirect) ─────

describe('accountApiRaw — transport hardening', () => {
  test('M1: enforces timeoutMs (a hung request rejects, does not stall to socket timeout)', async () => {
    // Never resolves — without an applied timeout this test would hang forever.
    const fetchImpl: FetchLike = () => new Promise<Response>(() => {});

    const start = Date.now();
    const err = await rejectedWith(
      accountApiRaw('GET', '/users/me', { apiKey: 't', region: 'eu1', timeoutMs: 30, fetchImpl }),
    );
    expect(err.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(Date.now() - start).toBeLessThan(1000); // bounded by timeoutMs, not the 120s socket
  });

  test('wraps a raw fetch failure in a coded MakeError (so the LLM sees [DEPENDENCY_UNAVAILABLE])', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const err = await rejectedWith(
      accountApiRaw('POST', '/scenarios/1/run', { apiKey: 't', region: 'eu1', fetchImpl }),
    );
    // BITES: without the wrap this would be a bare TypeError (no .code) and the
    // agent could mistake a failed run for a retryable transport blip.
    expect(err).toBeInstanceOf(MakeError);
    expect(err.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(err.message.startsWith('[DEPENDENCY_UNAVAILABLE]')).toBe(true);
  });

  test('redirect:3xx is terminal (redirect:error throws → coded MakeError, never followed)', async () => {
    const { fetchImpl, calls } = redirectAwareFetch('https://eu1.make.com/');
    const err = await rejectedWith(
      accountApiRaw('GET', '/users/me', { apiKey: 't', region: 'eu1', fetchImpl }),
    );
    expect(err.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('169.254.169.254'))).toBe(false);
  });

  test('parses Retry-After into the result (seconds → ms)', async () => {
    const { fetchImpl } = recorder(
      () => new Response('boom', { status: 429, headers: { 'retry-after': '2' } }),
    );
    const raw = await accountApiRaw('GET', '/scenarios', { apiKey: 't', region: 'eu1', fetchImpl });
    expect(raw.status).toBe(429);
    expect(raw.retryAfterMs).toBe(2000);
  });
});

// ─── parseRetryAfterMs — parse + clamp (hostile header can't hang us) ────────

describe('parseRetryAfterMs', () => {
  const withHeader = (value?: string) =>
    new Response('', { status: 429, headers: value != null ? { 'retry-after': value } : {} });

  test('seconds → ms', () => {
    expect(parseRetryAfterMs(withHeader('5'))).toBe(5000);
    expect(parseRetryAfterMs(withHeader('0'))).toBe(0);
  });

  test('clamps to 30s (a hostile/huge value cannot stall a retry)', () => {
    expect(parseRetryAfterMs(withHeader('3600'))).toBe(30_000);
  });

  test('null for absent/invalid/negative', () => {
    expect(parseRetryAfterMs(withHeader(undefined))).toBeNull();
    expect(parseRetryAfterMs(withHeader('not-a-number'))).toBeNull();
    expect(parseRetryAfterMs(withHeader('-5'))).toBeNull();
  });
});
