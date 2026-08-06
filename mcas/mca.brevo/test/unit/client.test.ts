import { afterEach, describe, expect, it, mock } from 'bun:test';
import { BrevoApiError } from '../../src/lib/_brevo-error';
import { brevoRequest } from '../../src/lib/brevo-client';
import { shapeCampaign, shapeContact } from '../../src/tools/_helpers';
import { createContact } from '../../src/tools/create-contact';

/**
 * Boundary tests for the Brevo HTTP client with a FAITHFUL `fetch` mock.
 *
 * The mock hands the client REAL `Response` objects (real `Headers`, real
 * `.text()`/204 semantics) — exactly what global `fetch` returns. A mock that
 * diverges from the real boundary hides bugs (TER-369: a hand-rolled header
 * combiner let a duplicated `Bearer` header pass green). Here we exercise the
 * production code paths: retry policy, auth header, query serialization, the
 * 201-vs-204 created/updated branch, and the null-safe response shapers.
 */

type Ctx = Parameters<typeof brevoRequest>[0];
const ctx = (): Ctx =>
  ({ getUserSecrets: async () => ({ BREVO_API_KEY: 'secret-key' }) }) as unknown as Ctx;

/** Build a real Response like undici/bun's `fetch` returns. */
function res(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  const hasBody = body !== undefined && status !== 204;
  return new Response(hasBody ? JSON.stringify(body) : null, {
    status,
    headers: { ...(hasBody ? { 'content-type': 'application/json' } : {}), ...headers },
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Queue responses; each call returns the next (clone), repeating the last. */
function stubFetch(...responses: Response[]) {
  let i = 0;
  const f = mock(async () => responses[Math.min(i++, responses.length - 1)].clone());
  globalThis.fetch = f as unknown as typeof fetch;
  return f;
}

describe('brevoRequest — retry policy (idempotent GET only, CLAUDE.md §14.10)', () => {
  it('POST is NEVER retried on 429 — without an idempotency key a retry duplicates', async () => {
    const f = stubFetch(res(429, { message: 'Too many requests' }, { 'retry-after': '0.001' }));
    let caught: unknown;
    try {
      await brevoRequest(ctx(), '/contacts', { method: 'POST', body: { email: 'a@b.com' } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BrevoApiError);
    expect((caught as BrevoApiError).code).toBe('RATE_LIMITED');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('GET retries a transient 429 up to 3 attempts, then throws RATE_LIMITED', async () => {
    const f = stubFetch(res(429, { message: 'slow down' }, { 'retry-after': '0.001' }));
    let caught: unknown;
    try {
      await brevoRequest(ctx(), '/contacts');
    } catch (e) {
      caught = e;
    }
    expect((caught as BrevoApiError).code).toBe('RATE_LIMITED');
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('GET does not retry a successful 200', async () => {
    const f = stubFetch(res(200, { contacts: [], count: 0 }));
    await brevoRequest(ctx(), '/contacts');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('brevoRequest — auth header + URL', () => {
  it('authenticates with the `api-key` header, never a Bearer token', async () => {
    const f = stubFetch(res(200, { ok: true }));
    await brevoRequest(ctx(), '/account');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['api-key']).toBe('secret-key');
    expect(headers).not.toHaveProperty('authorization');
    expect(headers).not.toHaveProperty('Authorization');
    expect(JSON.stringify(init.headers)).not.toMatch(/bearer/i);
    expect(url).toBe('https://api.brevo.com/v3/account');
  });

  it('serializes query params and drops undefined / null', async () => {
    const f = stubFetch(res(200, { campaigns: [], count: 0 }));
    await brevoRequest(ctx(), '/emailCampaigns', {
      query: { status: 'inProcess', limit: 50, type: undefined, offset: null },
    });
    const [url] = f.mock.calls[0] as unknown as [string];
    expect(url).toContain('status=inProcess');
    expect(url).toContain('limit=50');
    expect(url).not.toContain('type=');
    expect(url).not.toContain('offset=');
  });
});

describe('create-contact handler — created (201) vs updated (204)', () => {
  it('201 with an id → updated:false (a brand-new contact was created)', async () => {
    const f = stubFetch(res(201, { id: 42 }));
    const out = await createContact.handler({ email: 'a@b.com', listIds: [3] }, ctx());
    expect(out).toEqual({ id: 42, email: 'a@b.com', listIds: [3], updated: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('204 empty body + updateEnabled → updated:true (an existing contact was updated)', async () => {
    stubFetch(res(204));
    const out = await createContact.handler({ email: 'a@b.com', updateEnabled: true }, ctx());
    expect(out).toEqual({ id: null, email: 'a@b.com', listIds: [], updated: true });
  });

  it('POST carries the JSON content-type and a stringified body', async () => {
    const f = stubFetch(res(201, { id: 1 }));
    await createContact.handler({ email: 'a@b.com' }, ctx());
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ email: 'a@b.com' }));
  });
});

describe('response shapers — null-safety guards the renderer', () => {
  it('shapeContact({}) fills [] / null defaults (never undefined, never throws)', () => {
    expect(shapeContact({})).toEqual({
      id: null,
      email: null,
      emailBlacklisted: null,
      smsBlacklisted: null,
      listIds: [],
      attributes: null,
      createdAt: null,
      modifiedAt: null,
    });
  });

  it('shapeContact({ listIds: null }) → [] — a null here would crash PillList/.map in the renderer', () => {
    expect(shapeContact({ listIds: null }).listIds).toEqual([]);
  });

  it('shapeCampaign({}) → all-null shape', () => {
    expect(shapeCampaign({})).toEqual({
      id: null,
      name: null,
      subject: null,
      type: null,
      status: null,
      scheduledAt: null,
      createdAt: null,
      modifiedAt: null,
    });
  });

  it('shapers tolerate a non-object raw (parseOutput failure string / null)', () => {
    expect(shapeContact('garbage').listIds).toEqual([]);
    expect(shapeCampaign(null).id).toBeNull();
  });
});
