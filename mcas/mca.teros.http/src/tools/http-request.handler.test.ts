import { afterEach, describe, expect, it, mock } from 'bun:test';
import { httpRequest } from './http-request';

// A ToolContext stub — the handler only touches getUserSecrets().
function ctx(userSecrets: Record<string, string>) {
  return {
    getUserSecrets: async () => userSecrets,
    getSystemSecrets: async () => ({}),
  } as any;
}

/** A ToolContext whose getUserSecrets THROWS, mirroring a user with zero secrets
 *  (the SDK rejects with "No user secrets available"). `mock` lets us assert it was
 *  never called on the lazy path. */
function throwingCtx() {
  const getUserSecrets = mock(async () => {
    throw new Error('No user secrets available');
  });
  return { ctx: { getUserSecrets, getSystemSecrets: async () => ({}) } as any, getUserSecrets };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Install a fake global fetch returning the given response; record calls. */
function stubFetch(
  status = 200,
  body = '{"ok":true}',
  headers: Record<string, string> = { 'content-type': 'application/json' },
) {
  // Typed args so `.mock.calls[0][0|1]` is `unknown` (indexable), not an empty tuple.
  const fetchMock = mock((..._args: unknown[]) =>
    Promise.resolve(new Response(body, { status, headers })),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** Install a fake global fetch returning a specific Response (for stream bodies). */
function stubFetchResponse(resp: Response) {
  const fetchMock = mock((..._args: unknown[]) => Promise.resolve(resp));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('httpRequest handler', () => {
  it('injects the secret into the OUTGOING request but never echoes it back', async () => {
    const fetchMock = stubFetch();
    const result: any = await httpRequest.handler(
      // 1.1.1.1 is a public IP literal → the SSRF guard passes without DNS.
      { method: 'GET', url: 'https://1.1.1.1/v2/x?api_key={{HUNTER_API_KEY}}' },
      ctx({ HUNTER_API_KEY: 'REALSECRET' }),
    );

    // The real request carried the resolved key...
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('api_key=REALSECRET');

    // ...but nothing the model sees contains it.
    expect(JSON.stringify(result.request)).not.toContain('REALSECRET');
    expect(result.request.url).toContain('{{HUNTER_API_KEY}}');
    expect(result.response.status).toBe(200);
    expect(result.response.ok).toBe(true);
    expect(result.response.body).toEqual({ ok: true });
  });

  it('substitutes a secret placed in a header and masks it in the echo', async () => {
    const fetchMock = stubFetch(201, '{"messageId":"abc"}');
    const result: any = await httpRequest.handler(
      {
        method: 'POST',
        url: 'https://1.1.1.1/v3/smtp/email',
        headers: { 'api-key': '{{BREVO_API_KEY}}' },
        body: '{"subject":"Hi"}',
      },
      ctx({ BREVO_API_KEY: 'brevo-xyz' }),
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['api-key']).toBe('brevo-xyz');
    // default Content-Type added for a bodied request
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"subject":"Hi"}');
    // echo masks the credential header
    expect(result.request.headers['api-key']).toBe('{{BREVO_API_KEY}}');
  });

  it('rejects an unknown method before doing anything', async () => {
    const fetchMock = stubFetch();
    await expect(
      httpRequest.handler({ method: 'CONNECT', url: 'https://1.1.1.1/' }, ctx({})),
    ).rejects.toThrow('[BAD_METHOD]');
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('fails loud when a referenced secret is not configured', async () => {
    stubFetch();
    await expect(
      httpRequest.handler({ url: 'https://1.1.1.1/?api_key={{NOPE}}' }, ctx({})),
    ).rejects.toThrow('[MISSING_SECRET]');
  });

  it('blocks an internal address end-to-end (SSRF guard)', async () => {
    const fetchMock = stubFetch();
    await expect(
      httpRequest.handler({ url: 'http://127.0.0.1/admin' }, ctx({})),
    ).rejects.toThrow(/BLOCKED/);
    // guard rejects BEFORE the network call
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it('ignores a body on GET', async () => {
    const fetchMock = stubFetch();
    await httpRequest.handler(
      { method: 'GET', url: 'https://1.1.1.1/', body: '{"x":1}' },
      ctx({}),
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeUndefined();
  });
});

// ── C1: lazy secrets ─────────────────────────────────────────────────────────
describe('httpRequest handler — lazy secrets (C1)', () => {
  it('does NOT call getUserSecrets when the request has no placeholders', async () => {
    const fetchMock = stubFetch();
    const { ctx: c, getUserSecrets } = throwingCtx();
    const result: any = await httpRequest.handler(
      { method: 'GET', url: 'https://1.1.1.1/public/data' },
      c,
    );
    // The eager bug would throw "No user secrets available" here.
    expect(result.response.status).toBe(200);
    expect(getUserSecrets).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('still fails loud with [MISSING_SECRET] (not "No user secrets") when a placeholder is used but the user has none', async () => {
    stubFetch();
    const { ctx: c } = throwingCtx();
    await expect(
      httpRequest.handler({ url: 'https://1.1.1.1/?api_key={{NEEDS}}' }, c),
    ).rejects.toThrow('[MISSING_SECRET]');
  });
});

// ── C2: scrub reflected secret VALUES ────────────────────────────────────────
describe('httpRequest handler — secret-value leak guard (C2)', () => {
  it('scrubs a reflected secret value from the body, nested fields and headers', async () => {
    stubFetch(
      200,
      JSON.stringify({ youSent: 'api_key=REALSECRET', nested: { token: 'REALSECRET' } }),
      { 'content-type': 'application/json', 'x-echo': 'REALSECRET' },
    );
    const result: any = await httpRequest.handler(
      { url: 'https://1.1.1.1/echo?api_key={{HUNTER_API_KEY}}' },
      ctx({ HUNTER_API_KEY: 'REALSECRET' }),
    );
    // Nothing the model sees carries the value.
    expect(JSON.stringify(result)).not.toContain('REALSECRET');
    // Structure preserved, value replaced.
    expect(result.response.body.youSent).toBe('api_key=***');
    expect(result.response.body.nested.token).toBe('***');
    expect(result.response.headers['x-echo']).toBe('***');
  });

  it('scrubs a secret value reflected in a NON-json (text) body', async () => {
    stubFetch(200, 'echo: REALSECRET here', { 'content-type': 'text/plain' });
    const result: any = await httpRequest.handler(
      { url: 'https://1.1.1.1/echo?api_key={{K}}' },
      ctx({ K: 'REALSECRET' }),
    );
    expect(result.response.body).toBe('echo: *** here');
  });

  it('scrubs a secret value echoed inside an error message', async () => {
    // safeFetch rejects to a redirect with no Location; we instead simulate the
    // common case: a fetch error whose message embeds the (resolved) host.
    globalThis.fetch = mock(() =>
      Promise.reject(new Error('connect ECONNREFUSED for token=REALSECRET')),
    ) as unknown as typeof fetch;
    await expect(
      httpRequest.handler({ url: 'https://1.1.1.1/?token={{K}}' }, ctx({ K: 'REALSECRET' })),
    ).rejects.toThrow(/\*\*\*/);
    // and crucially NOT the raw value
    await expect(
      httpRequest.handler({ url: 'https://1.1.1.1/?token={{K}}' }, ctx({ K: 'REALSECRET' })),
    ).rejects.not.toThrow(/REALSECRET/);
  });

  it('masks credential-NAMED response headers even when the value is not a known secret', async () => {
    stubFetch(200, '{"ok":true}', {
      'content-type': 'application/json',
      authorization: 'Bearer reflected-token',
      'x-request-id': 'abc-123',
    });
    const result: any = await httpRequest.handler({ url: 'https://1.1.1.1/' }, ctx({}));
    expect(result.response.headers.authorization).toBe('***');
    expect(result.response.headers['x-request-id']).toBe('abc-123');
  });
});

// ── M1: streaming size cap ───────────────────────────────────────────────────
describe('httpRequest handler — response size cap (M1)', () => {
  it('aborts with [RESPONSE_TOO_LARGE] for an over-cap body WITHOUT content-length', async () => {
    let sent = 0;
    const total = 6 * 1024 * 1024; // 6MB > 5MB cap
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) return controller.close();
        controller.enqueue(new Uint8Array(256 * 1024)); // fresh chunk, no content-length
        sent += 256 * 1024;
      },
    });
    stubFetchResponse(
      new Response(stream, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    );
    await expect(httpRequest.handler({ url: 'https://1.1.1.1/big' }, ctx({}))).rejects.toThrow(
      '[RESPONSE_TOO_LARGE]',
    );
  });

  it('rejects with [RESPONSE_TOO_LARGE] when content-length advertises an over-cap body', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(8));
        c.close();
      },
    });
    stubFetchResponse(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/plain', 'content-length': String(6 * 1024 * 1024) },
      }),
    );
    await expect(httpRequest.handler({ url: 'https://1.1.1.1/' }, ctx({}))).rejects.toThrow(
      '[RESPONSE_TOO_LARGE]',
    );
  });

  it('accepts a body just under the cap and reports its real size', async () => {
    const size = 64 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(size));
        c.close();
      },
    });
    stubFetchResponse(
      new Response(stream, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    );
    const result: any = await httpRequest.handler({ url: 'https://1.1.1.1/ok' }, ctx({}));
    expect(result.response.sizeBytes).toBe(size);
    expect(result.response.truncated).toBe(false);
  });
});

// ── M6: http:// + secrets gated by NODE_ENV ─────────────────────────────────
describe('httpRequest handler — plaintext http in production (M6)', () => {
  const prev = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = prev;
  });

  it('refuses to send secrets over plaintext http:// in production', async () => {
    process.env.NODE_ENV = 'production';
    const fetchMock = stubFetch();
    await expect(
      httpRequest.handler({ url: 'http://1.1.1.1/?api_key={{K}}' }, ctx({ K: 'sek' })),
    ).rejects.toThrow('[INSECURE_TRANSPORT]');
    expect(fetchMock.mock.calls.length).toBe(0); // never sent
  });

  it('allows https:// with secrets in production', async () => {
    process.env.NODE_ENV = 'production';
    const fetchMock = stubFetch();
    const result: any = await httpRequest.handler(
      { url: 'https://1.1.1.1/?api_key={{K}}' },
      ctx({ K: 'sek' }),
    );
    expect(result.response.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it('allows plain http:// WITHOUT secrets in production (nothing to leak)', async () => {
    process.env.NODE_ENV = 'production';
    stubFetch();
    const result: any = await httpRequest.handler({ url: 'http://1.1.1.1/public' }, ctx({}));
    expect(result.response.status).toBe(200);
  });

  it('allows secrets over http:// outside production (dev)', async () => {
    process.env.NODE_ENV = 'development';
    const fetchMock = stubFetch();
    const result: any = await httpRequest.handler(
      { url: 'http://1.1.1.1/?api_key={{K}}' },
      ctx({ K: 'sek' }),
    );
    expect(result.response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toContain('api_key=sek');
  });
});

// ── M7: secret in query and body ─────────────────────────────────────────────
describe('httpRequest handler — secret in query / body (M7)', () => {
  it('resolves a secret in a query param, echoes the placeholder, never the value', async () => {
    const fetchMock = stubFetch();
    const result: any = await httpRequest.handler(
      { method: 'GET', url: 'https://1.1.1.1/v2/x', query: { token: '{{K}}' } },
      ctx({ K: 'resolved-key' }),
    );
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('token=resolved-key');
    expect(result.request.query.token).toBe('{{K}}');
    expect(JSON.stringify(result)).not.toContain('resolved-key');
  });

  it('resolves a secret embedded in the request body', async () => {
    const fetchMock = stubFetch(201, '{"ok":true}');
    await httpRequest.handler(
      { method: 'POST', url: 'https://1.1.1.1/v1/x', body: '{"k":"{{S}}"}' },
      ctx({ S: 'body-secret' }),
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe('{"k":"body-secret"}');
  });

  it('percent-encodes a secret carrying URL metacharacters in the URL string', async () => {
    const fetchMock = stubFetch();
    await httpRequest.handler(
      { url: 'https://1.1.1.1/path/{{TOK}}/end' },
      ctx({ TOK: 'a/b c' }),
    );
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    // "/" and " " encoded → no path injection, no broken URL
    expect(calledUrl).toContain('/path/a%2Fb%20c/end');
  });
});

// ── Minor: timeout validation + bad placeholder ──────────────────────────────
describe('httpRequest handler — input validation (minors)', () => {
  it('does not abort instantly when timeoutMs is not finite (NaN → default)', async () => {
    stubFetch();
    const result: any = await httpRequest.handler(
      { url: 'https://1.1.1.1/', timeoutMs: Number.NaN as unknown as number },
      ctx({}),
    );
    expect(result.response.status).toBe(200);
  });

  it('fails loud with [BAD_PLACEHOLDER] on a malformed {{ ... }} reference', async () => {
    stubFetch();
    await expect(
      httpRequest.handler({ url: 'https://1.1.1.1/{{ bad-name }}' }, ctx({ 'bad-name': 'x' })),
    ).rejects.toThrow('[BAD_PLACEHOLDER]');
  });
});
