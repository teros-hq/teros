import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { NotionApiError } from '../../src/lib/_notion-error';
import { getNotionClient } from '../../src/lib/notion-client';

/**
 * End-to-end tests for the refresh-on-401 fetch hook in `notion-client.ts`.
 *
 * We patch the global `fetch` because the Notion SDK accepts a `SupportedFetch`
 * option and our `getNotionClient` injects its own wrapper that DELEGATES to
 * `globalThis.fetch`. So the request order from the SDK's perspective is:
 *
 *   1. SDK → our hook → globalThis.fetch (API call w/ stale token)
 *   2. our hook sees 401 → POST globalThis.fetch (oauth/token refresh)
 *   3. our hook retries → globalThis.fetch (API call w/ fresh token)
 *
 * The mock records each call in order so we can assert on URL and headers.
 */

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let queuedResponses: Response[] = [];

function installFetchMock(seq: Response[]): void {
  calls = [];
  queuedResponses = [...seq];
  // biome-ignore lint/suspicious/noExplicitAny: matching DOM fetch signature
  globalThis.fetch = (async (url: any, init: any) => {
    // Materialize headers exactly as the platform `fetch` does: `new Headers()`
    // COMBINES duplicate case-insensitive keys with ", ". A forgiving mock
    // (Object.entries, last-wins) hid the `Authorization: Bearer X, Bearer X`
    // bug that broke Notion OAuth 100% (the SDK injects lowercase `authorization`,
    // our hook added a capital `Authorization` → combined → rejected). TER-369.
    const headersObj: Record<string, string> = {};
    const norm = new Headers((init?.headers ?? {}) as HeadersInit);
    norm.forEach((v: string, k: string) => {
      headersObj[k.toLowerCase()] = v;
    });

    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: headersObj,
      body: init?.body ? String(init.body) : undefined,
    });

    const next = queuedResponses.shift();
    if (!next) {
      throw new Error(`Unexpected fetch call #${calls.length} to ${url}`);
    }
    return next;
    // biome-ignore lint/suspicious/noExplicitAny: matching DOM fetch return
  }) as any;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface MockContextOpts {
  userSecrets?: Record<string, string>;
  systemSecrets?: Record<string, string>;
}

function buildContext(opts: MockContextOpts = {}) {
  const updates: Array<Record<string, string>> = [];
  const context = {
    getSystemSecrets: async () =>
      opts.systemSecrets ?? { CLIENT_ID: 'test-client-id', CLIENT_SECRET: 'test-client-secret' },
    getUserSecrets: async () =>
      opts.userSecrets ?? {
        ACCESS_TOKEN: 'access-old',
        REFRESH_TOKEN: 'refresh-old',
      },
    updateUserSecrets: async (s: Record<string, string>) => {
      updates.push(s);
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal ToolContext mock
  } as any;
  return { context, updates };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  calls = [];
  queuedResponses = [];
});

describe('getNotionClient — happy path (no refresh needed)', () => {
  it('uses ACCESS_TOKEN as-is when API returns 200', async () => {
    installFetchMock([jsonResponse(200, { id: 'user-1', name: 'Antonio' })]);
    const { context, updates } = buildContext();
    const client = await getNotionClient(context);

    // biome-ignore lint/suspicious/noExplicitAny: SDK return type wrapped
    const me: any = await client.users.me({});

    expect(me.id).toBe('user-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.authorization).toBe('Bearer access-old');
    expect(updates).toHaveLength(0);
  });

  it('sends a SINGLE Authorization header — no "Bearer X, Bearer X" (TER-369 regression)', async () => {
    installFetchMock([jsonResponse(200, { id: 'user-1' })]);
    const { context } = buildContext();
    const client = await getNotionClient(context);
    // biome-ignore lint/suspicious/noExplicitAny: SDK return wrapped
    await (client.users.me({}) as any);

    // The SDK injects a lowercase `authorization` from its `auth` option; the
    // fetch hook must REPLACE it (Headers.set), not append a second capital
    // `Authorization`. With the mock now materializing via real `new Headers()`,
    // a regression would surface here as the combined "Bearer …, Bearer …".
    const auth = calls[0].headers.authorization;
    expect(auth).toBe('Bearer access-old');
    expect(auth).not.toContain(',');
  });
});

describe('getNotionClient — refresh on 401', () => {
  it('refreshes and retries with the new token on a single 401', async () => {
    installFetchMock([
      jsonResponse(401, { code: 'unauthorized', message: 'API token is invalid.' }),
      jsonResponse(200, {
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_in: 3600,
      }),
      jsonResponse(200, { id: 'user-1' }),
    ]);
    const { context, updates } = buildContext();
    const client = await getNotionClient(context);

    // biome-ignore lint/suspicious/noExplicitAny: SDK return wrapped
    const me: any = await client.users.me({});

    expect(me.id).toBe('user-1');
    expect(calls).toHaveLength(3);

    // 1. Initial API call with stale token
    expect(calls[0].url).toContain('api.notion.com');
    expect(calls[0].headers.authorization).toBe('Bearer access-old');

    // 2. Refresh call to oauth/token with Basic Auth
    expect(calls[1].url).toBe('https://api.notion.com/v1/oauth/token');
    expect(calls[1].method).toBe('POST');
    expect(calls[1].headers.authorization).toMatch(/^Basic /);
    expect(calls[1].body).toContain('grant_type=refresh_token');
    expect(calls[1].body).toContain('refresh_token=refresh-old');

    // 3. Retry with new token
    expect(calls[2].url).toContain('api.notion.com');
    expect(calls[2].headers.authorization).toBe('Bearer access-new');

    // updateUserSecrets called with rotated credentials + new expiry
    expect(updates).toHaveLength(1);
    expect(updates[0].ACCESS_TOKEN).toBe('access-new');
    expect(updates[0].REFRESH_TOKEN).toBe('refresh-new');
    expect(updates[0].EXPIRY_DATE).toBeDefined();
  });

  it('persists rotated refresh_token only when Notion sends it back', async () => {
    installFetchMock([
      jsonResponse(401, { code: 'unauthorized', message: 'expired' }),
      // Notion sometimes returns the same refresh_token (no rotation this turn).
      jsonResponse(200, { access_token: 'access-new', expires_in: 3600 }),
      jsonResponse(200, { id: 'user-1' }),
    ]);
    const { context, updates } = buildContext();
    const client = await getNotionClient(context);
    await client.users.me({});

    expect(updates[0].ACCESS_TOKEN).toBe('access-new');
    expect(updates[0].REFRESH_TOKEN).toBeUndefined();
  });

  it('throws AUTH_EXPIRED when the refresh endpoint rejects the refresh_token (400)', async () => {
    installFetchMock([
      jsonResponse(401, { code: 'unauthorized', message: 'expired' }),
      jsonResponse(400, { error: 'invalid_grant', error_description: 'refresh token revoked' }),
    ]);
    const { context } = buildContext();
    const client = await getNotionClient(context);

    let thrown: unknown;
    try {
      await client.users.me({});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NotionApiError);
    expect((thrown as NotionApiError).classified.code).toBe('AUTH_EXPIRED');
    expect((thrown as NotionApiError).message).toMatch(/^\[AUTH_EXPIRED\]/);
  });

  it('throws PROVIDER_ERROR when the refresh endpoint 5xxs', async () => {
    installFetchMock([
      jsonResponse(401, { code: 'unauthorized', message: 'expired' }),
      new Response('upstream gateway error', { status: 503 }),
    ]);
    const { context } = buildContext();
    const client = await getNotionClient(context);

    let thrown: unknown;
    try {
      await client.users.me({});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NotionApiError);
    expect((thrown as NotionApiError).classified.code).toBe('PROVIDER_ERROR');
  });
});

describe('getNotionClient — preflight failures', () => {
  it('throws AUTH_REQUIRED when ACCESS_TOKEN is missing', async () => {
    const { context } = buildContext({
      userSecrets: { REFRESH_TOKEN: 'r' }, // no ACCESS_TOKEN
    });

    let thrown: unknown;
    try {
      await getNotionClient(context);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NotionApiError);
    expect((thrown as NotionApiError).classified.code).toBe('AUTH_REQUIRED');
  });
});
