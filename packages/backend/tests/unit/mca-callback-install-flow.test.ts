import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { McaOAuth } from '../../src/auth/mca-oauth';
import { HttpMcaAuthHandler } from '../../src/handlers/http-mca-auth-handler';

class FakeRes {
  statusCode = 0;
  body = '';
  ended = false;
  writeHead(code: number): this {
    this.statusCode = code;
    return this;
  }
  end(data?: string): this {
    if (data) this.body = data;
    this.ended = true;
    return this;
  }
}

function handler(appUrl?: string) {
  return new HttpMcaAuthHandler(
    { peekState: async () => null } as any,
    {} as any,
    {} as any,
    { system: () => (appUrl ? { appUrl } : {}) } as any,
    {} as any,
    {} as any,
  );
}

async function call(h: HttpMcaAuthHandler, url: string) {
  const res = new FakeRes();
  await h.handleRoute({ method: 'GET', url, headers: { host: 'be.test' } } as any, res as any, url);
  return res;
}

let savedAppUrl: string | undefined;
beforeEach(() => {
  savedAppUrl = process.env.APP_URL;
  delete process.env.APP_URL;
});
afterEach(() => {
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
});

describe('install and callback flow (014)', () => {
  it("installing from GitHub's own App page ends on a success page", async () => {
    const res = await call(handler('https://app.test'), '/auth/mca/callback?installation_id=12345678&setup_action=install');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Missing required parameters');
    expect(res.body).toContain('installed');
  });

  it("installing from GitHub's page with OAuth during installation (code, no state) also ends on a success page", async () => {
    const res = await call(handler('https://app.test'), '/auth/mca/callback?code=abc123&installation_id=12345678&setup_action=install');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Missing required parameters');
    expect(res.body).toContain('installed');
  });

  it('a callback that cannot render its page still answers the browser', async () => {
    const res = await call(handler(undefined), '/auth/mca/callback?error=access_denied&state=x');
    expect(res.ended).toBe(true);
    expect(res.statusCode).toBe(500);
  });
});

describe('reconnecting GitHub keeps the installation id (014)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('a callback without installation_id keeps the stored one', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('access_token')
        ? { access_token: 'ghu_new', refresh_token: 'ghr_new', expires_in: 28800, refresh_token_expires_in: 15_000_000 }
        : { login: 'octocat', id: 1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as any;
    let saved: Record<string, unknown> = {};
    const authManager = {
      get: async () => ({ USER_ACCESS_TOKEN: 'ghu_old', INSTALLATION_ID: '42' }),
      set: async (_u: string, _a: string, _m: string, creds: Record<string, unknown>) => {
        saved = creds;
      },
      merge: async (_u: string, _a: string, _m: string, creds: Record<string, unknown>) => {
        saved = { ...saved, ...creds };
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
    const secretsManager = { mca: () => ({ GITHUB_APP_CLIENT_ID: 'cid', GITHUB_APP_CLIENT_SECRET: 'cs' }) } as any;
    const catalog = {
      findOne: async () => ({
        mcaId: 'mca.github',
        auth: { type: 'github-app', userOAuth: true, provider: 'github', tokenUrl: 'https://github.com/login/oauth/access_token' },
      }),
    } as any;
    const oauth = new McaOAuth(db, authManager, secretsManager, catalog);

    const result = await oauth.handleCallback('code', 's', 'https://be.test/auth/mca/callback', {});

    expect(result.success).toBe(true);
    expect(saved.USER_ACCESS_TOKEN).toBe('ghu_new');
    expect(saved.INSTALLATION_ID).toBe('42');
  });
});
