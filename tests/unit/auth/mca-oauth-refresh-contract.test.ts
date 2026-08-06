/**
 * Contract-boundary test for McaOAuth.refreshToken — asserts the EXACT POST that
 * leaves the process at the real boundary (global `fetch`), not just "fetch was
 * called". This is the TER-369 class of bug: Notion OAuth shipped 100% broken
 * with CI green because a loose mock never exercised the real request shape.
 *
 * The mock reads headers via `new Headers(init.headers)` — exactly how the
 * platform's `fetch` normalizes them — so the assertion can't pass on a shape
 * the real boundary would reject.
 *
 * Confirmed against Notion docs (developers.notion.com/docs/authorization): the
 * token endpoint requires HTTP Basic Auth for EVERY grant, including
 * refresh_token. The fix makes refreshToken mirror exchangeCode's Basic-auth
 * logic for `basicAuth` providers (Notion, Figma) — TER-443.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { McaOAuth } from '../../../packages/backend/src/auth/mca-oauth';

const TOKEN_URL = 'https://api.notion.com/v1/oauth/token';
const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  method?: string;
  headers: Headers;
  body: URLSearchParams;
}

function buildOAuth(provider: string) {
  const captured: { value: Captured | null } = { value: null };

  globalThis.fetch = mock(async (url: any, init: any) => {
    captured.value = {
      url: String(url),
      method: init?.method,
      headers: new Headers(init?.headers), // faithful: real fetch normalizes here
      body: new URLSearchParams(init?.body),
    };
    return new Response(
      JSON.stringify({ access_token: 'new_at', refresh_token: 'new_rt', expires_in: 3600 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as any;

  const db: any = { collection: () => ({}) };
  const authManager: any = {
    get: async () => ({ REFRESH_TOKEN: 'old_rt', ACCESS_TOKEN: 'old_at' }),
    merge: async () => {},
  };
  const secretsManager: any = {
    mca: () => ({ CLIENT_ID: 'the_client_id', CLIENT_SECRET: 'the_client_secret' }),
  };
  const catalogCollection: any = {
    findOne: async () => ({ mcaId: 'mca.x', auth: { tokenUrl: TOKEN_URL, provider } }),
  };

  const oauth = new McaOAuth(db, authManager, secretsManager, catalogCollection);
  return { oauth, captured };
}

describe('McaOAuth.refreshToken — token endpoint contract (TER-443)', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('Notion (basicAuth provider): sends Authorization: Basic and keeps creds OUT of the body', async () => {
    const { oauth, captured } = buildOAuth('notion');

    const res = await oauth.refreshToken('user_1', 'app_1', 'mca.x');
    expect(res.success).toBe(true);

    const c = captured.value!;
    expect(c.url).toBe(TOKEN_URL);
    expect(c.method).toBe('POST');

    const expected = `Basic ${Buffer.from('the_client_id:the_client_secret').toString('base64')}`;
    expect(c.headers.get('authorization')).toBe(expected);

    expect(c.body.get('grant_type')).toBe('refresh_token');
    expect(c.body.get('refresh_token')).toBe('old_rt');
    // For Basic-auth providers the credentials must NOT be duplicated in the body.
    expect(c.body.get('client_id')).toBeNull();
    expect(c.body.get('client_secret')).toBeNull();
  });

  it('standard provider (no basicAuth): client creds go in the body, no Authorization header', async () => {
    const { oauth, captured } = buildOAuth('some_standard_provider');

    await oauth.refreshToken('user_1', 'app_1', 'mca.x');

    const c = captured.value!;
    expect(c.headers.get('authorization')).toBeNull();
    expect(c.body.get('client_id')).toBe('the_client_id');
    expect(c.body.get('client_secret')).toBe('the_client_secret');
    expect(c.body.get('grant_type')).toBe('refresh_token');
  });
});
