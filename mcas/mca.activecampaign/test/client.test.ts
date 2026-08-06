import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ToolContext } from '@teros/mca-sdk';
import {
  __setAcResolveHostForTests,
  __setAcSleepForTests,
  ActiveCampaignAuthError,
  ActiveCampaignError,
  ActiveCampaignNotFoundError,
  ActiveCampaignRateLimitError,
  acRequest,
} from '../src/lib/index.js';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const calls: FetchCall[] = [];
let nextResponse: () => Response;

const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  // SSRF guard resolves DNS; inject a fake public resolver so unit tests never
  // touch the network (the host is still scheme/port/literal-validated). Make
  // retry backoff instant so retry tests don't sleep.
  __setAcResolveHostForTests(async () => [{ address: '104.16.0.1' }]);
  __setAcSleepForTests(async () => {});
  nextResponse = () =>
    new Response(JSON.stringify({ users: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  // biome-ignore lint/suspicious/noExplicitAny: fetch monkey-patch in test
  (globalThis as any).fetch = async (input: any, init?: any) => {
    calls.push({
      url: typeof input === 'string' ? input : input.url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    });
    return nextResponse();
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __setAcResolveHostForTests(undefined);
  __setAcSleepForTests(undefined);
});

function makeContext(secrets: Record<string, string>): ToolContext {
  return {
    execution: { userId: 'u1', appId: 'a1' },
    backend: null,
    requestId: 'req_test',
    getSystemSecrets: async () => ({}),
    getUserSecrets: async () => secrets,
    updateUserSecrets: async () => {},
    getScope: () => 'u1',
    getData: async () => ({ value: null, exists: false }),
    setData: async () => ({ success: true }),
    deleteData: async () => ({ success: true, deleted: false }),
    listData: async () => ({ keys: [] }),
    // biome-ignore lint/suspicious/noExplicitAny: ToolContext is loose in tests
  } as any;
}

const validSecrets = {
  ACTIVECAMPAIGN_BASE_URL: 'https://test.api-us1.com',
  ACTIVECAMPAIGN_API_TOKEN: 'token-abc',
};

describe('acRequest happy path', () => {
  test('uses Api-Token header and resolves /api/3 path automatically', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ users: [{ id: '1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const result = (await acRequest(makeContext(validSecrets), '/users/me')) as {
      users: unknown[];
    };
    expect(result.users).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://test.api-us1.com/api/3/users/me');
    expect(calls[0].method).toBe('GET');
    expect((calls[0].headers as Record<string, string>)['Api-Token']).toBe('token-abc');
  });

  test('appends searchParams', async () => {
    await acRequest(makeContext(validSecrets), '/contacts', {
      searchParams: { limit: 5, offset: 10, search: 'jane' },
    });
    expect(calls[0].url).toBe(
      'https://test.api-us1.com/api/3/contacts?limit=5&offset=10&search=jane',
    );
  });

  test('omits empty/undefined searchParams', async () => {
    await acRequest(makeContext(validSecrets), '/contacts', {
      searchParams: { limit: 5, search: undefined, listid: '' },
    });
    expect(calls[0].url).toBe('https://test.api-us1.com/api/3/contacts?limit=5');
  });

  test('strips trailing slash from baseUrl', async () => {
    await acRequest(
      makeContext({ ...validSecrets, ACTIVECAMPAIGN_BASE_URL: 'https://test.api-us1.com/' }),
      '/contacts',
    );
    expect(calls[0].url).toBe('https://test.api-us1.com/api/3/contacts');
  });

  test('respects /api/ prefix when caller passes one', async () => {
    await acRequest(makeContext(validSecrets), '/api/3/users/me');
    expect(calls[0].url).toBe('https://test.api-us1.com/api/3/users/me');
  });

  test('serialises POST body', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ contact: { id: '99' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await acRequest(makeContext(validSecrets), '/contact/sync', {
      method: 'POST',
      body: { contact: { email: 'x@y.z' } },
    });
    expect(calls[0].method).toBe('POST');
    expect((calls[0].headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].body!)).toEqual({ contact: { email: 'x@y.z' } });
  });

  test('returns null on 204', async () => {
    nextResponse = () => new Response(null, { status: 204 });
    const result = await acRequest(makeContext(validSecrets), '/contacts/1', { method: 'DELETE' });
    expect(result).toBeNull();
  });
});

describe('acRequest credentials validation', () => {
  test('throws AUTH_INVALID without baseUrl', async () => {
    let err: unknown = null;
    try {
      await acRequest(makeContext({ ACTIVECAMPAIGN_API_TOKEN: 'x' }), '/users/me');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActiveCampaignError);
    expect((err as ActiveCampaignError).code).toBe('AUTH_INVALID');
  });

  test('throws AUTH_INVALID without apiToken', async () => {
    let err: unknown = null;
    try {
      await acRequest(
        makeContext({ ACTIVECAMPAIGN_BASE_URL: 'https://x.api-us1.com' }),
        '/users/me',
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActiveCampaignError);
    expect((err as ActiveCampaignError).code).toBe('AUTH_INVALID');
  });
});

describe('acRequest SSRF guard', () => {
  test('rejects a non-https baseUrl before any request', async () => {
    let err: unknown = null;
    try {
      await acRequest(
        makeContext({ ...validSecrets, ACTIVECAMPAIGN_BASE_URL: 'http://test.api-us1.com' }),
        '/users/me',
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActiveCampaignError);
    expect((err as ActiveCampaignError).code).toBe('AUTH_INVALID');
    expect(calls).toHaveLength(0);
  });

  test('blocks an internal/loopback host', async () => {
    let err: unknown = null;
    try {
      await acRequest(
        makeContext({ ...validSecrets, ACTIVECAMPAIGN_BASE_URL: 'https://localhost' }),
        '/users/me',
      );
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain('BLOCKED');
    expect(calls).toHaveLength(0);
  });

  test('blocks the cloud metadata IP', async () => {
    let err: unknown = null;
    try {
      await acRequest(
        makeContext({ ...validSecrets, ACTIVECAMPAIGN_BASE_URL: 'https://169.254.169.254' }),
        '/users/me',
      );
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain('BLOCKED');
    expect(calls).toHaveLength(0);
  });

  test('blocks a host that resolves to a private address (DNS rebinding)', async () => {
    __setAcResolveHostForTests(async () => [{ address: '10.0.0.5' }]);
    let err: unknown = null;
    try {
      await acRequest(makeContext(validSecrets), '/users/me');
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain('BLOCKED');
    expect(calls).toHaveLength(0);
  });
});

describe('acRequest error mapping', () => {
  test('401 -> AuthError', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ errors: [{ title: 'invalid token' }] }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    let err: unknown = null;
    try {
      await acRequest(makeContext(validSecrets), '/users/me');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActiveCampaignAuthError);
    expect((err as ActiveCampaignAuthError).upstreamMessage).toBe('invalid token');
  });

  test('404 -> NotFoundError, no retry on GET', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ message: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    let err: unknown = null;
    try {
      await acRequest(makeContext(validSecrets), '/contacts/999');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActiveCampaignNotFoundError);
    expect(calls).toHaveLength(1);
  });

  test('GET 500 retries up to 3 times', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ errors: [{ title: 'server error' }] }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    let err: unknown = null;
    try {
      await acRequest(makeContext(validSecrets), '/contacts');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActiveCampaignError);
    expect(calls).toHaveLength(3); // 1 initial + 2 retries
  });

  test('POST 500 does NOT retry (mutation safety)', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ errors: [{ title: 'server error' }] }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    let err: unknown = null;
    try {
      await acRequest(makeContext(validSecrets), '/contact/sync', {
        method: 'POST',
        body: { contact: { email: 'x@y.z' } },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(calls).toHaveLength(1);
  });

  test('429 -> RateLimitError with Retry-After', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({}), {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '7' },
      });
    let err: unknown = null;
    try {
      await acRequest(makeContext(validSecrets), '/contacts/1', { method: 'DELETE' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActiveCampaignRateLimitError);
    expect((err as ActiveCampaignRateLimitError).retryAfterSeconds).toBe(7);
  });

  test('GET 429 is retried (honouring Retry-After) before surfacing', async () => {
    nextResponse = () =>
      new Response(JSON.stringify({}), {
        status: 429,
        headers: { 'content-type': 'application/json', 'Retry-After': '1' },
      });
    let err: unknown = null;
    try {
      await acRequest(makeContext(validSecrets), '/contacts');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActiveCampaignRateLimitError);
    expect(calls).toHaveLength(3); // 1 initial + 2 retries on 429 GET
  });
});
