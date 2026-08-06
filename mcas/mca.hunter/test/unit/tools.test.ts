import { afterEach, describe, expect, test } from 'bun:test';
import { domainSearch } from '../../src/tools/domain-search';
import { emailFinder } from '../../src/tools/email-finder';
import { emailVerifier } from '../../src/tools/email-verifier';
import { healthCheck } from '../../src/tools/health-check';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type CtxOverrides = {
  getUserSecrets?: () => Promise<Record<string, string>>;
  signal?: AbortSignal;
};

function makeContext(
  userSecrets: Record<string, string> = { HUNTER_API_KEY: 'sk-test' },
  overrides: CtxOverrides = {},
) {
  return {
    execution: { userId: 'u1', appId: 'a1' },
    backend: null,
    signal: overrides.signal ?? new AbortController().signal,
    getSystemSecrets: async () => ({}),
    getUserSecrets: overrides.getUserSecrets ?? (async () => userSecrets),
    updateUserSecrets: async () => {},
    getScope: () => 'u1',
    getData: async () => ({ value: null, exists: false }),
    setData: async () => ({ success: true }),
  } as unknown as Parameters<typeof domainSearch.handler>[1];
}

/** Capture the outgoing request URL + headers and stub the `{ data, meta }` envelope. */
function stubFetch(data: unknown, meta: unknown = {}): { url: () => string; headers: () => Headers } {
  let seenUrl = '';
  let seenHeaders = new Headers();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seenUrl = String(input);
    seenHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ data, meta }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { url: () => seenUrl, headers: () => seenHeaders };
}

/** Stub a non-2xx (or any status) response body for error-path coverage. */
function stubStatus(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

type HealthResult = { status: string; issues?: Array<{ code: string }> };

describe('domain-search', () => {
  test('curates the payload to the exact output shape', async () => {
    const stub = stubFetch({
      domain: 'stripe.com',
      organization: 'Stripe',
      pattern: '{first}',
      webmail: false,
      disposable: false,
      accept_all: true,
      emails: [
        {
          value: 'patrick@stripe.com',
          type: 'personal',
          confidence: 97,
          first_name: 'Patrick',
          last_name: 'Collison',
          position: 'CEO',
          seniority: 'executive',
          department: 'executive',
          linkedin: 'in/patrick',
          twitter: 'patrickc',
          phone_number: null,
          sources: [{ uri: 'x' }],
        },
      ],
    });

    const out = (await domainSearch.handler(
      { domain: 'stripe.com', limit: 10 },
      makeContext(),
    )) as Awaited<ReturnType<typeof domainSearch.handler>>;

    expect(out).toEqual({
      domain: 'stripe.com',
      organization: 'Stripe',
      pattern: '{first}',
      webmail: false,
      disposable: false,
      acceptAll: true,
      total: 1,
      emails: [
        {
          value: 'patrick@stripe.com',
          type: 'personal',
          confidence: 97,
          firstName: 'Patrick',
          lastName: 'Collison',
          position: 'CEO',
          seniority: 'executive',
          department: 'executive',
          linkedin: 'in/patrick',
          twitter: 'patrickc',
          phoneNumber: null,
        },
      ],
    });
    // M5: key in header, NOT the URL.
    expect(stub.url()).not.toContain('api_key');
    expect(stub.headers().get('x-api-key')).toBe('sk-test');
    expect(stub.url()).toContain('domain=stripe.com');
    expect(stub.url()).toContain('limit=10');
  });

  test('total comes from meta.results (the real total), not the page size (M4)', async () => {
    stubFetch(
      { domain: 'stripe.com', emails: [{ value: 'a@stripe.com' }] },
      { results: 42, limit: 10, offset: 0 },
    );
    const out = (await domainSearch.handler(
      { domain: 'stripe.com', limit: 10 },
      makeContext(),
    )) as Awaited<ReturnType<typeof domainSearch.handler>>;
    expect(out.total).toBe(42);
    expect(out.emails).toHaveLength(1);
  });

  test('total falls back to the page size when meta.results is absent', async () => {
    stubFetch({
      domain: 'stripe.com',
      emails: [{ value: 'a@stripe.com' }, { value: 'b@stripe.com' }],
    });
    const out = (await domainSearch.handler(
      { domain: 'stripe.com' },
      makeContext(),
    )) as Awaited<ReturnType<typeof domainSearch.handler>>;
    expect(out.total).toBe(2);
  });

  test('normalizes a URL into a bare host', async () => {
    const stub = stubFetch({ domain: 'stripe.com', emails: [] });
    await domainSearch.handler({ domain: 'https://stripe.com/pricing' }, makeContext());
    expect(stub.url()).toContain('domain=stripe.com');
    expect(stub.url()).not.toContain('pricing');
  });

  test('rejects empty domain with [BAD_REQUEST]', async () => {
    await expect(domainSearch.handler({ domain: '  ' }, makeContext())).rejects.toThrow(
      /\[BAD_REQUEST\].*domain/,
    );
  });

  test('rejects an invalid domain', async () => {
    await expect(domainSearch.handler({ domain: 'not a domain' }, makeContext())).rejects.toThrow(
      /\[BAD_REQUEST\]/,
    );
  });

  test('rejects out-of-range limit', async () => {
    await expect(
      domainSearch.handler({ domain: 'stripe.com', limit: 999 }, makeContext()),
    ).rejects.toThrow(/limit must be an integer in \[1, 100\]/);
  });

  test('throws [AUTH_INVALID] when no API key is configured', async () => {
    await expect(domainSearch.handler({ domain: 'stripe.com' }, makeContext({}))).rejects.toThrow(
      /\[AUTH_INVALID\]/,
    );
  });

  test('propagates [DEPENDENCY_UNAVAILABLE] when the secrets backend throws (not AUTH_INVALID)', async () => {
    const ctx = makeContext({}, {
      getUserSecrets: async () => {
        throw new Error('secrets backend down');
      },
    });
    await expect(domainSearch.handler({ domain: 'stripe.com' }, ctx)).rejects.toThrow(
      /\[DEPENDENCY_UNAVAILABLE\]/,
    );
  });
});

describe('email-finder', () => {
  test('maps the payload to the exact output shape', async () => {
    const stub = stubFetch({
      email: 'patrick@stripe.com',
      score: 92,
      domain: 'stripe.com',
      first_name: 'Patrick',
      last_name: 'Collison',
      position: 'CEO',
      company: 'Stripe',
      linkedin_url: 'in/patrick',
      twitter: 'patrickc',
      phone_number: null,
      verification: { status: 'valid', date: '2024-01-01' },
    });

    const out = (await emailFinder.handler(
      { domain: 'stripe.com', first_name: 'Patrick', last_name: 'Collison' },
      makeContext(),
    )) as Awaited<ReturnType<typeof emailFinder.handler>>;

    expect(out).toEqual({
      email: 'patrick@stripe.com',
      score: 92,
      domain: 'stripe.com',
      firstName: 'Patrick',
      lastName: 'Collison',
      position: 'CEO',
      company: 'Stripe',
      linkedin: 'in/patrick',
      twitter: 'patrickc',
      phoneNumber: null,
      verificationStatus: 'valid',
    });
    expect(stub.url()).toContain('first_name=Patrick');
    expect(stub.url()).toContain('last_name=Collison');
    expect(stub.url()).not.toContain('api_key');
    expect(stub.headers().get('x-api-key')).toBe('sk-test');
  });

  test('requires first_name and last_name', async () => {
    await expect(
      emailFinder.handler({ domain: 'stripe.com', first_name: '', last_name: 'X' }, makeContext()),
    ).rejects.toThrow(/first_name/);
    await expect(
      emailFinder.handler({ domain: 'stripe.com', first_name: 'X', last_name: '  ' }, makeContext()),
    ).rejects.toThrow(/last_name/);
  });
});

describe('email-verifier', () => {
  test('maps the payload to the exact output shape', async () => {
    const stub = stubFetch({
      email: 'patrick@stripe.com',
      status: 'valid',
      result: 'deliverable',
      score: 99,
      regexp: true,
      gibberish: false,
      disposable: false,
      webmail: false,
      mx_records: true,
      smtp_server: true,
      smtp_check: true,
      accept_all: false,
      block: false,
    });

    const out = (await emailVerifier.handler(
      { email: 'patrick@stripe.com' },
      makeContext(),
    )) as Awaited<ReturnType<typeof emailVerifier.handler>>;

    expect(out).toEqual({
      email: 'patrick@stripe.com',
      status: 'valid',
      result: 'deliverable',
      score: 99,
      gibberish: false,
      disposable: false,
      webmail: false,
      acceptAll: false,
      block: false,
      mxRecords: true,
      smtpServer: true,
      smtpCheck: true,
    });
    expect(stub.url()).toContain('email=patrick%40stripe.com');
    expect(stub.headers().get('x-api-key')).toBe('sk-test');
  });

  test('rejects an invalid email with [BAD_REQUEST]', async () => {
    await expect(emailVerifier.handler({ email: 'not-an-email' }, makeContext())).rejects.toThrow(
      /\[BAD_REQUEST\].*email/,
    );
  });
});

describe('-health-check', () => {
  test('no key configured → not_ready + AUTH_REQUIRED, with no API call', async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response('{}');
    }) as typeof fetch;

    const res = (await healthCheck.handler({}, makeContext({}))) as HealthResult;
    expect(res.status).toBe('not_ready');
    expect(res.issues?.[0]?.code).toBe('AUTH_REQUIRED');
    expect(fetched).toBe(false);
  });

  test('valid key + /account 200 → ready, no issues', async () => {
    stubFetch({ email: 'me@co.com' });
    const res = (await healthCheck.handler({}, makeContext())) as HealthResult;
    expect(res.status).toBe('ready');
    expect(res.issues).toBeUndefined();
  });

  test('/account 401 → not_ready + AUTH_INVALID', async () => {
    stubStatus(401, { errors: [{ id: 'wrong_auth', details: 'bad key' }] });
    const res = (await healthCheck.handler({}, makeContext())) as HealthResult;
    expect(res.status).toBe('not_ready');
    expect(res.issues?.[0]?.code).toBe('AUTH_INVALID');
  });

  test('/account 429 → not_ready + QUOTA_EXCEEDED', async () => {
    stubStatus(429, { errors: [{ id: 'usage_limit_reached', details: 'out of credits' }] });
    const res = (await healthCheck.handler({}, makeContext())) as HealthResult;
    expect(res.status).toBe('not_ready');
    expect(res.issues?.[0]?.code).toBe('QUOTA_EXCEEDED');
  });

  test('/account 403 → degraded + RATE_LIMITED (auto_retry, non-blocking)', async () => {
    stubStatus(403, { errors: [{ id: 'rate_limit', details: 'slow down' }] });
    const res = (await healthCheck.handler({}, makeContext())) as HealthResult;
    expect(res.status).toBe('degraded');
    expect(res.issues?.[0]?.code).toBe('RATE_LIMITED');
  });

  test('/account 500 → degraded + DEPENDENCY_UNAVAILABLE', async () => {
    stubStatus(500, { errors: [{ id: 'srv', details: 'boom' }] });
    const res = (await healthCheck.handler({}, makeContext())) as HealthResult;
    expect(res.status).toBe('degraded');
    expect(res.issues?.[0]?.code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  test('non-HunterError (caller-cancelled fetch) → generic DEPENDENCY_UNAVAILABLE branch', async () => {
    let calls = 0;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof fetch;

    const ctx = makeContext({ HUNTER_API_KEY: 'sk-test' }, { signal: AbortSignal.abort() });
    const res = (await healthCheck.handler({}, ctx)) as HealthResult;
    expect(res.status).toBe('degraded');
    expect(res.issues?.[0]?.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(calls).toBe(1);
  });
});
