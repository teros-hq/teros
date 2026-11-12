import { afterEach, describe, expect, it } from 'bun:test';
import { McaOAuth, clearGitHubInstallationCache } from '../../src/auth/mca-oauth';

const realFetch = globalThis.fetch;
const GITHUB_APP_AUTH = {
  type: 'github-app',
  userOAuth: true,
  provider: 'github',
  appSlug: 'teros-ai-prod',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  permissions: { contents: 'write', workflows: 'write' },
  systemSecrets: ['GITHUB_APP_CLIENT_ID'],
  userSecrets: ['USER_ACCESS_TOKEN'],
};
const MCA = { mcaId: 'mca.github', auth: GITHUB_APP_AUTH, userSecrets: ['USER_ACCESS_TOKEN'], systemSecrets: ['GITHUB_APP_CLIENT_ID'] } as any;

const CREDS = {
  USER_ACCESS_TOKEN: 'ghu_status_test',
  USER_LOGIN: 'octocat',
  EXPIRY_DATE: new Date(Date.now() + 3_600_000).toISOString(),
  REFRESH_TOKEN: 'ghr_x',
};

function makeOAuth() {
  const authManager = { get: async () => ({ ...CREDS }) } as any;
  const db = { collection: () => ({ createIndex: async () => {}, findOne: async () => null }) } as any;
  const secretsManager = { mca: () => ({ GITHUB_APP_CLIENT_ID: 'cid', GITHUB_APP_SLUG: 'teros-ai-prod' }) } as any;
  const catalog = { findOne: async () => MCA } as any;
  return new McaOAuth(db, authManager, secretsManager, catalog);
}

function answer(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as any;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearGitHubInstallationCache();
});

describe('GitHub status knows whether the App can reach anything (013)', () => {
  it('connected but installed nowhere → not installed, with the install link', async () => {
    answer(200, { total_count: 0, installations: [] });
    const status = await makeOAuth().getAuthStatus('user_1', 'app_1', MCA);
    expect(status.githubApp?.installed).toBe(false);
    expect(status.githubApp?.installUrl).toBe('https://github.com/apps/teros-ai-prod/installations/select_target');
    expect(status.message).toMatch(/not installed/i);
  });

  it('a token GitHub rejects (revoked) is expired, not ready', async () => {
    answer(401, { message: 'Bad credentials' });
    const status = await makeOAuth().getAuthStatus('user_1', 'app_1', MCA);
    expect(status.status).toBe('expired');
  });

  it('lists installations with their own manage URL and pending permissions', async () => {
    answer(200, {
      total_count: 1,
      installations: [
        {
          id: 77,
          account: { login: 'acme', type: 'Organization' },
          html_url: 'https://github.com/organizations/acme/settings/installations/77',
          permissions: { contents: 'write' },
          suspended_at: null,
        },
      ],
    });
    const status = await makeOAuth().getAuthStatus('user_1', 'app_1', MCA);
    expect(status.status).toBe('ready');
    expect(status.githubApp?.installed).toBe(true);
    expect(status.githubApp?.installations).toEqual([
      {
        id: '77',
        account: 'acme',
        accountType: 'Organization',
        manageUrl: 'https://github.com/organizations/acme/settings/installations/77',
        pendingPermissions: ['workflows'],
      },
    ]);
  });
});

describe('installation webhooks refresh the status at once (013)', () => {
  it.each(['deleted', 'suspend', 'unsuspend', 'new_permissions_accepted'])('%s drops the cached installations', async (action) => {
    const { GitHubAppService } = await import('../../src/auth/github-app');
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ installations: [{ id: 77, account: { login: 'acme' }, permissions: {} }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any;
    const oauth = makeOAuth();
    await oauth.getAuthStatus('user_1', 'app_1', MCA);
    await oauth.getAuthStatus('user_1', 'app_1', MCA);
    expect(calls).toBe(1);

    const db = {
      collection: () => ({ find: () => ({ toArray: async () => [] }), createIndex: async () => {} }),
    } as any;
    const service = new GitHubAppService(db, {} as any, oauth, {} as any);
    await service.processInstallationEvent({ action, installation: { id: 77, account: { login: 'acme' } } } as any);
    await oauth.getAuthStatus('user_1', 'app_1', MCA);
    expect(calls).toBe(2);
  });
});

describe('the GitHub status lists the branches where removed clones saved their work (gh-scope-4)', () => {
  it('reads saved-branches.json from the workspace volume', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const base = mkdtempSync(join(tmpdir(), 'vols-'));
    const saved = [{ repo: 'acme/api', branch: 'teros/saved/agent_a/main-20261028-1015', savedAt: '2026-10-28T10:15:00.000Z', url: 'https://github.com/acme/api/tree/teros/saved/agent_a/main-20261028-1015' }];
    mkdirSync(join(base, 'workspaces', 'vol_1', '.teros-github'), { recursive: true });
    writeFileSync(join(base, 'workspaces', 'vol_1', '.teros-github', 'saved-branches.json'), JSON.stringify(saved));
    const prev = process.env.VOLUMES_BASE_PATH;
    process.env.VOLUMES_BASE_PATH = base;
    answer(200, { installations: [] });
    const authManager = { get: async () => ({ ...CREDS }) } as any;
    const rows: Record<string, any> = {
      apps: { appId: 'app_1', ownerId: 'work_1', ownerType: 'workspace', mcaId: 'mca.github' },
      workspaces: { workspaceId: 'work_1', volumeId: 'vol_1' },
    };
    const db = { collection: (name: string) => ({ createIndex: async () => {}, findOne: async () => rows[name] ?? null }) } as any;
    const secretsManager = { mca: () => ({ GITHUB_APP_CLIENT_ID: 'cid', GITHUB_APP_SLUG: 'teros-ai-prod' }) } as any;
    const oauth = new McaOAuth(db, authManager, secretsManager, { findOne: async () => MCA } as any);
    try {
      const status = await oauth.getAuthStatus('user_1', 'app_1', MCA);
      expect(status.githubApp?.savedBranches).toEqual(saved);
    } finally {
      if (prev === undefined) delete process.env.VOLUMES_BASE_PATH;
      else process.env.VOLUMES_BASE_PATH = prev;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
