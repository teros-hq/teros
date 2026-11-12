import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { getInstallationContext, getUser } from '../../src/tools';

interface MockContext {
  getUserSecrets: () => Promise<Record<string, string>>;
  getSystemSecrets: () => Promise<Record<string, string>>;
}

// v5+ uses user-to-server access tokens. Tests inject USER_ACCESS_TOKEN
// directly so the resolver returns it without hitting the GitHub OAuth flow.
const ctx: MockContext = {
  getUserSecrets: async () => ({
    USER_ACCESS_TOKEN: 'ghu_test_user_access_token_123',
    USER_REFRESH_TOKEN: 'ghr_test_refresh_token',
    USER_TOKEN_EXPIRES_AT: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    USER_LOGIN: 'octocat',
  }),
  getSystemSecrets: async () => ({
    GITHUB_APP_ID: '1',
    GITHUB_APP_CLIENT_ID: 'Iv23liEXAMPLE',
    GITHUB_APP_CLIENT_SECRET: 'cs_example',
    GITHUB_APP_PRIVATE_KEY: 'placeholder',
    GITHUB_APP_SLUG: 'teros',
  }),
};

interface FakeFetchSpec {
  status?: number;
  body?: unknown;
  /** Route responses by URL substring: [{ match: '/user/installations', body: {...} }] */
  routes?: Array<{ match: string; body: unknown }>;
}

let originalFetch: typeof fetch;
let lastRequest: { url: string; init?: RequestInit } | null = null;

function mockFetch(spec: FakeFetchSpec) {
  const status = spec.status ?? 200;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    lastRequest = { url, init };
    const body =
      spec.routes?.find((r) => url.includes(r.match))?.body ?? spec.body ?? {};
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  lastRequest = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// =============================================================================
// get-user — real token identity (GET /user)
// =============================================================================

describe('get-user', () => {
  it('GETs /user and returns the real token identity', async () => {
    mockFetch({
      body: {
        login: 'jamogon',
        name: 'Javi',
        html_url: 'https://github.com/jamogon',
        type: 'User',
      },
    });
    const result = (await getUser.handler({}, ctx as any)) as Record<string, unknown>;

    expect(lastRequest?.url).toMatch(/\/user$/);
    expect(lastRequest?.url).not.toContain('/user/installations');
    expect(lastRequest?.init?.method ?? 'GET').toBe('GET');
    expect(result.login).toBe('jamogon');
    expect(result.name).toBe('Javi');
    expect(result.html_url).toBe('https://github.com/jamogon');
    expect(result.type).toBe('User');
  });

  it('never returns the installations schema', async () => {
    mockFetch({
      body: {
        login: 'supertowers',
        name: null,
        html_url: 'https://github.com/supertowers',
        type: 'User',
      },
    });
    const result = (await getUser.handler({}, ctx as any)) as Record<string, unknown>;

    expect('installations' in result).toBe(false);
    expect('app' in result).toBe(false);
    expect('install_url' in result).toBe(false);
  });

  it('defaults optional fields when GitHub omits them', async () => {
    mockFetch({ body: { login: 'octocat' } });
    const result = (await getUser.handler({}, ctx as any)) as Record<string, unknown>;

    expect(result.login).toBe('octocat');
    expect(result.name).toBeNull();
    expect(result.html_url).toBeNull();
    expect(result.type).toBe('User');
  });

  it('throws when the response carries no login', async () => {
    mockFetch({ body: { message: 'Requires authentication' } });
    expect(getUser.handler({}, ctx as any)).rejects.toThrow(/no login/i);
  });

  it('is marked read-only', () => {
    expect(getUser.annotations?.readOnlyHint).toBe(true);
  });
});

// =============================================================================
// get-installation-context — reachable installations, with explicit disclaimer
// =============================================================================

describe('get-installation-context', () => {
  it('includes the disclaimer note in the payload (installations present)', async () => {
    mockFetch({
      routes: [
        {
          // GET /user/installations (no query-string match needed — the repos
          // route below is longer and must be listed first to win).
          match: '/user/installations/135789084/repositories',
          body: { total_count: 1, repositories: [{ full_name: 'supertowers/teros', private: false }] },
        },
        {
          match: '/user/installations',
          body: {
            total_count: 1,
            installations: [
              {
                id: 135789084,
                account: { login: 'supertowers', type: 'User' },
                repository_selection: 'selected',
                permissions: { contents: 'write' },
              },
            ],
          },
        },
      ],
    });
    const result = (await getInstallationContext.handler({}, ctx as any)) as Record<
      string,
      unknown
    >;

    expect(typeof result.note).toBe('string');
    expect(result.note).toMatch(/NOT the user identity/i);
    expect(result.note).toMatch(/get-user/);
    expect(Array.isArray(result.installations)).toBe(true);
    expect((result.installations as Array<Record<string, unknown>>).length).toBe(1);
    const inst = (result.installations as Array<Record<string, unknown>>)[0];
    expect(inst.account).toBe('supertowers');
    expect(inst.repository_count).toBe(1);
  });

  it('includes the disclaimer note in the payload (no installations)', async () => {
    mockFetch({ body: { total_count: 0, installations: [] } });
    const result = (await getInstallationContext.handler({}, ctx as any)) as Record<
      string,
      unknown
    >;

    expect(typeof result.note).toBe('string');
    expect(result.note).toMatch(/NOT the user identity/i);
    expect(result.installations).toEqual([]);
  });

  it('still hits /user/installations and is marked read-only', async () => {
    mockFetch({ body: { total_count: 0, installations: [] } });
    await getInstallationContext.handler({}, ctx as any);
    expect(lastRequest?.url).toContain('/user/installations');
    expect(getInstallationContext.annotations?.readOnlyHint).toBe(true);
  });

  it('org installations get an org-scoped manage_url, user installations keep the personal one', async () => {
    // Mirrors the real setup that surfaced the bug: supertowers (User),
    // teros-hq (Organization) and acme-corp (Organization), plus a defensive
    // account: null entry that must fall back to the personal pattern.
    mockFetch({
      routes: [
        {
          match: '/user/installations/135789084/repositories',
          body: { total_count: 1, repositories: [{ full_name: 'supertowers/teros', private: false }] },
        },
        {
          match: '/user/installations/130322575/repositories',
          body: { total_count: 2, repositories: [{ full_name: 'teros-hq/platform', private: true }] },
        },
        {
          match: '/user/installations/10000001/repositories',
          body: { total_count: 1, repositories: [{ full_name: 'acme-corp/acme-corp', private: true }] },
        },
        {
          match: '/user/installations/999999999/repositories',
          body: { total_count: 0, repositories: [] },
        },
        {
          match: '/user/installations',
          body: {
            total_count: 4,
            installations: [
              {
                id: 135789084,
                account: { login: 'supertowers', type: 'User' },
                repository_selection: 'selected',
                permissions: { contents: 'write' },
              },
              {
                id: 130322575,
                account: { login: 'teros-hq', type: 'Organization' },
                repository_selection: 'all',
                permissions: { contents: 'write' },
              },
              {
                id: 10000001,
                account: { login: 'acme-corp', type: 'Organization' },
                repository_selection: 'selected',
                permissions: { contents: 'write' },
              },
              {
                id: 999999999,
                account: null,
                repository_selection: 'selected',
                permissions: {},
              },
            ],
          },
        },
      ],
    });
    const result = (await getInstallationContext.handler({}, ctx as any)) as Record<
      string,
      unknown
    >;
    const installations = result.installations as Array<Record<string, unknown>>;

    const byId = new Map(installations.map((i) => [i.id, i]));
    expect(byId.size).toBe(4);

    // User account → personal settings pattern.
    expect(byId.get(135789084)?.manage_url).toBe(
      'https://github.com/settings/installations/135789084',
    );
    // Org accounts → org-scoped pattern (the personal one 404s for orgs).
    expect(byId.get(130322575)?.manage_url).toBe(
      'https://github.com/organizations/teros-hq/settings/installations/130322575',
    );
    expect(byId.get(10000001)?.manage_url).toBe(
      'https://github.com/organizations/acme-corp/settings/installations/10000001',
    );
    // account: null → defensive fallback to the personal pattern.
    expect(byId.get(999999999)?.manage_url).toBe(
      'https://github.com/settings/installations/999999999',
    );
  });
});
