import { afterEach, describe, expect, it, mock } from 'bun:test';
import { McaOAuth } from '../../src/auth/mca-oauth';

const realFetch = globalThis.fetch;
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_APP_AUTH = { type: 'github-app', userOAuth: true, provider: 'github', tokenUrl: TOKEN_URL };

const WORKING = {
  ACCESS_TOKEN: 'old_at',
  REFRESH_TOKEN: 'old_rt',
  EXPIRY_DATE: '2026-01-01T00:00:00.000Z',
  USER_ACCESS_TOKEN: 'old_at',
  USER_REFRESH_TOKEN: 'old_rt',
  USER_TOKEN_EXPIRES_AT: '2026-01-01T00:00:00.000Z',
  USER_LOGIN: 'octocat',
  INSTALLATION_ID: '42',
};

function jsonResponse(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(answer: () => Promise<Response> | Response): { calls: number } {
  const counter = { calls: 0 };
  globalThis.fetch = mock(async () => {
    counter.calls++;
    return answer();
  }) as any;
  return counter;
}

function makeOAuth(initial: Record<string, string>, opts?: { rereads?: Record<string, string>[] }) {
  let blob = JSON.stringify(initial);
  const rereads = [...(opts?.rereads ?? [])];
  const calls = { merge: 0, set: 0, get: 0 };
  const authManager = {
    get: async () => {
      if (calls.get++ > 0 && rereads.length > 0) blob = JSON.stringify(rereads.shift());
      return JSON.parse(blob);
    },
    merge: async (_u: string, _a: string, _m: string, patch: Record<string, unknown>) => {
      calls.merge++;
      blob = JSON.stringify({ ...JSON.parse(blob), ...patch });
    },
    set: async (_u: string, _a: string, _m: string, creds: Record<string, unknown>) => {
      calls.set++;
      blob = JSON.stringify(creds);
    },
  } as any;
  const stateDoc = {
    state: 's',
    appId: 'app_1',
    userId: 'user_1',
    mcaId: 'mca.github',
    provider: 'github',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
  };
  const db = {
    collection: () => ({
      createIndex: async () => {},
      findOne: async () => null,
      findOneAndDelete: async () => stateDoc,
    }),
  } as any;
  const secretsManager = {
    mca: () => ({ GITHUB_APP_CLIENT_ID: 'cid', GITHUB_APP_CLIENT_SECRET: 'csecret' }),
  } as any;
  const catalogCollection = { findOne: async () => ({ mcaId: 'mca.github', auth: GITHUB_APP_AUTH }) } as any;
  const oauth = new McaOAuth(db, authManager, secretsManager, catalogCollection);
  return { oauth, calls, stored: () => JSON.parse(blob) };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('refreshToken — failed refresh keeps the stored credentials', () => {
  it('200 + bad_refresh_token → success:false, nothing merged, tokens intact', async () => {
    mockFetch(() => jsonResponse({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }));
    const { oauth, calls, stored } = makeOAuth(WORKING);

    const res = await oauth.refreshToken('user_1', 'app_1', 'mca.github');

    expect(res.success).toBe(false);
    expect(res.error).toContain('bad_refresh_token');
    expect(calls.merge).toBe(0);
    expect(stored()).toEqual(WORKING);
  });

  it('200 without access_token → success:false, nothing merged', async () => {
    mockFetch(() => jsonResponse({ token_type: 'bearer' }));
    const { oauth, calls, stored } = makeOAuth(WORKING);

    const res = await oauth.refreshToken('user_1', 'app_1', 'mca.github');

    expect(res.success).toBe(false);
    expect(calls.merge).toBe(0);
    expect(stored()).toEqual(WORKING);
  });

  it('fails after another caller already rotated the tokens → success:true, nothing merged', async () => {
    mockFetch(() => jsonResponse({ error: 'bad_refresh_token' }));
    const rotated = { ...WORKING, ACCESS_TOKEN: 'new_at', REFRESH_TOKEN: 'new_rt', USER_ACCESS_TOKEN: 'new_at' };
    const { oauth, calls, stored } = makeOAuth(WORKING, { rereads: [rotated] });

    const res = await oauth.refreshToken('user_1', 'app_1', 'mca.github');

    expect(res.success).toBe(true);
    expect(calls.merge).toBe(0);
    expect(stored()).toEqual(rotated);
  });

  it('non-2xx (invalid_grant) after another caller rotated the tokens → success:true', async () => {
    mockFetch(() => jsonResponse({ error: 'invalid_grant' }, 400));
    const rotated = { ...WORKING, ACCESS_TOKEN: 'new_at', REFRESH_TOKEN: 'new_rt' };
    const { oauth, calls } = makeOAuth(WORKING, { rereads: [rotated] });

    const res = await oauth.refreshToken('user_1', 'app_1', 'mca.github');

    expect(res.success).toBe(true);
    expect(calls.merge).toBe(0);
  });
});

describe('refreshToken — single-flight per (userId, appId)', () => {
  it('two concurrent refreshes hit the token endpoint once and both get the new token', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const counter = mockFetch(async () => {
      await gate;
      return jsonResponse({ access_token: 'new_at', refresh_token: 'new_rt', expires_in: 28800 });
    });
    const { oauth, stored } = makeOAuth(WORKING);

    const first = oauth.refreshToken('user_1', 'app_1', 'mca.github');
    const second = oauth.refreshToken('user_1', 'app_1', 'mca.github');
    await new Promise((r) => setTimeout(r, 10));
    release();
    const results = await Promise.all([first, second]);

    expect(counter.calls).toBe(1);
    expect(results).toEqual([{ success: true }, { success: true }]);
    expect(stored().USER_ACCESS_TOKEN).toBe('new_at');
    expect(stored().REFRESH_TOKEN).toBe('new_rt');
  });

  it('a successful response with error: null is still a success', async () => {
    mockFetch(() => jsonResponse({ access_token: 'new_at', refresh_token: 'new_rt', expires_in: 28800, error: null }));
    const { oauth, stored } = makeOAuth(WORKING);

    const res = await oauth.refreshToken('user_1', 'app_1', 'mca.github');

    expect(res.success).toBe(true);
    expect(stored().USER_ACCESS_TOKEN).toBe('new_at');
  });

  it('a later refresh after the first settles hits the endpoint again', async () => {
    const counter = mockFetch(() => jsonResponse({ access_token: 'new_at', refresh_token: 'new_rt', expires_in: 28800 }));
    const { oauth } = makeOAuth(WORKING);

    await oauth.refreshToken('user_1', 'app_1', 'mca.github');
    await oauth.refreshToken('user_1', 'app_1', 'mca.github');

    expect(counter.calls).toBe(2);
  });
});

describe('handleCallback — failed code exchange keeps working credentials', () => {
  it('200 + error from the token endpoint → success:false, authManager.set never called', async () => {
    mockFetch(() => jsonResponse({ error: 'bad_verification_code' }));
    const { oauth, calls, stored } = makeOAuth(WORKING);

    const res = await oauth.handleCallback('expired_code', 's', 'https://app/cb');

    expect(res.success).toBe(false);
    expect(res.error).toContain('bad_verification_code');
    expect(calls.set).toBe(0);
    expect(stored()).toEqual(WORKING);
  });

  it('200 without access_token → success:false, authManager.set never called', async () => {
    mockFetch(() => jsonResponse({ token_type: 'bearer' }));
    const { oauth, calls, stored } = makeOAuth(WORKING);

    const res = await oauth.handleCallback('code', 's', 'https://app/cb');

    expect(res.success).toBe(false);
    expect(calls.set).toBe(0);
    expect(stored()).toEqual(WORKING);
  });
});
