import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { githubRequestPacing } from '../../src/lib/github-client';
import { GitHubUserNotAuthenticatedError } from '../../src/lib/github-user-token';
import { classifyGitError } from '../../src/tools/_git-error';
import { REST_TOOLS } from '../../src/tools/rest-tools';

const secrets = {
  USER_ACCESS_TOKEN: 'ghu_rest_errors_token_1234567890',
  USER_LOGIN: 'octo',
};
const system = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'x', GITHUB_APP_SLUG: 'teros-ai-prod' };
const ctx = { getUserSecrets: async () => secrets, getSystemSecrets: async () => system } as never;
const noTokenCtx = { getUserSecrets: async () => ({}), getSystemSecrets: async () => system } as never;

const ARGS = {
  owner: 'acme',
  repo: 'api',
  org: 'acme',
  name: 'api',
  path: 'README.md',
  issue_number: 1,
  pull_number: 1,
  run_id: 1,
  workflow_id: 'ci.yml',
  ref: 'main',
  branch: 'main',
  base: 'main',
  head: 'feat',
  sha: 'abc123',
  title: 'title',
  body: 'body',
  message: 'msg',
  content: 'content',
  q: 'bug',
  query: 'bug',
  tag_name: 'v1.0.0',
  labels: ['bug'],
  reviewers: ['someone'],
  event: 'COMMENT',
  event_type: 'ping',
  from_branch: 'main',
};

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
let reply: (url: string, init?: RequestInit) => Reply;
let calls: Array<{ url: string; method: string }> = [];
const realFetch = globalThis.fetch;
const realPacing = { ...githubRequestPacing };

beforeEach(() => {
  calls = [];
  githubRequestPacing.baseDelayMs = 1;
  githubRequestPacing.maxRetryAfterMs = 1;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    const r = reply(url, init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(githubRequestPacing, realPacing);
});

async function failureOf(name: string, context = ctx): Promise<string> {
  try {
    await REST_TOOLS[name].handler({ ...ARGS }, context);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error(`${name} did not fail`);
}

describe('every REST tool error is classified for the agent (001)', () => {
  it('there are 42 REST tools', () => {
    expect(Object.keys(REST_TOOLS)).toHaveLength(42);
  });

  for (const name of Object.keys(REST_TOOLS)) {
    it(`${name}: 404 → [CODE] + What to do`, async () => {
      reply = () => ({ status: 404, body: { message: 'Not Found' } });
      const message = await failureOf(name);
      expect(message).toMatch(/^\[[A-Z_]+\] /);
      expect(message).toContain('What to do:');
      if (calls.length > 0) expect(message.startsWith('[NOT_FOUND]')).toBe(true);
    });
  }

  it('401 says the session expired and to reconnect in Teros', async () => {
    reply = () => ({ status: 401, body: { message: 'Bad credentials' } });
    const message = await failureOf('get-issue');
    expect(message.startsWith('[AUTH_EXPIRED]')).toBe(true);
    expect(message).toContain('Teros');
    expect(message).not.toContain('apps/teros/installations');
  });

  it('422 names the field GitHub rejected', async () => {
    reply = () => ({
      status: 422,
      body: { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] },
    });
    const message = await failureOf('create-issue');
    expect(message.startsWith('[VALIDATION]')).toBe(true);
    expect(message).toContain('title');
  });
});

describe('reconnect texts and rate limits (002)', () => {
  it('not connected: English, points to Teros, not to the App install page', async () => {
    const message = await failureOf('list-issues', noTokenCtx);
    expect(message.startsWith('[USER_NOT_AUTHENTICATED]')).toBe(true);
    expect(message).toContain('Teros');
    expect(message).not.toMatch(/Tu cuenta|Reconecta|installations\/new/);
    expect(new GitHubUserNotAuthenticatedError('x').message).not.toMatch(/Tu cuenta/);
  });

  it('a secondary rate limit with remaining 0 is SECONDARY_RATE_LIMIT', async () => {
    reply = () => ({
      status: 403,
      body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
      headers: { 'x-ratelimit-remaining': '0' },
    });
    expect((await failureOf('list-issues')).startsWith('[SECONDARY_RATE_LIMIT]')).toBe(true);
  });

  it('429 is RATE_LIMITED', async () => {
    reply = () => ({ status: 429, body: { message: 'API rate limit exceeded' } });
    expect((await failureOf('list-issues')).startsWith('[RATE_LIMITED]')).toBe(true);
  });

  it('App not installed links to the configured App slug', async () => {
    reply = () => ({ status: 403, body: { message: 'This installation has been suspended' } });
    const message = await failureOf('get-repo');
    expect(message).toContain('github.com/apps/teros-ai-prod');
  });
});

describe('workflow files (012 + workflows permission)', () => {
  const installations = (workflows: string | undefined) => ({
    status: 200,
    body: {
      total_count: 1,
      installations: [
        {
          id: 77,
          account: { login: 'acme', type: 'Organization' },
          html_url: 'https://github.com/organizations/acme/settings/installations/77',
          permissions: { contents: 'write', ...(workflows ? { workflows } : {}) },
        },
      ],
    },
  });

  it('pending permission: refused before any write, with the link to accept it', async () => {
    reply = (url) => (url.includes('/user/installations') ? installations(undefined) : { status: 404, body: { message: 'Not Found' } });
    let message = '';
    try {
      await REST_TOOLS['create-or-update-file'].handler(
        { owner: 'acme', repo: 'api', path: './.github/Workflows/ci.yml', message: 'ci', content: 'on: push\n' },
        ctx,
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.startsWith('[WORKFLOW_PERMISSION_PENDING]')).toBe(true);
    expect(message).toContain('https://github.com/organizations/acme/settings/installations/77');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('accepted permission: the workflow file is written', async () => {
    reply = (url, init) =>
      url.includes('/user/installations')
        ? installations('write')
        : init?.method === 'PUT'
          ? { status: 201, body: { content: { path: '.github/workflows/ci.yml' } } }
          : { status: 404, body: { message: 'Not Found' } };
    await REST_TOOLS['create-or-update-file'].handler(
      { owner: 'acme', repo: 'api', path: '.github/workflows/ci.yml', message: 'ci', content: 'on: push\n' },
      ctx,
    );
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
  });

  it('git-push refusal explains the pending permission, not a permanent Teros limit', () => {
    const classified = classifyGitError({
      code: 1,
      stdout: '',
      stderr:
        " ! [remote rejected] wf -> wf (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)",
      command: 'push',
    });
    expect(classified.code).toBe('GIT_WORKFLOW_PERMISSION');
    expect(classified.action.description).toContain('accept');
    expect(classified.action.description).not.toContain('Teros admin decision');
  });
});

describe('errors after the request are not reported as "nothing sent" (001)', () => {
  it('a TypeError inside a tool is UNEXPECTED, telling the agent to check before retrying', async () => {
    const { restTool } = await import('../../src/tools/rest-tools');
    const broken = restTool({
      description: 'x',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'login')");
      },
    } as never);
    let message = '';
    try {
      await broken.handler({}, ctx);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.startsWith('[UNEXPECTED]')).toBe(true);
    expect(message).not.toContain('nothing was sent');
    expect(message).toContain('before retrying');
  });
});

describe('"already exists" says what to do (001)', () => {
  it('a branch that exists is reported as existing, with the next step', async () => {
    reply = () => ({ status: 422, body: { message: 'Reference already exists' } });
    const message = await failureOf('create-branch');
    expect(message.startsWith('[ALREADY_EXISTS]')).toBe(true);
    expect(message).toMatch(/another name|use the existing/i);
  });
});

describe('git tools without a connection say what to do (002)', () => {
  it('clone-repo with no token → [USER_NOT_AUTHENTICATED] + What to do', async () => {
    const { cloneRepo } = await import('../../src/tools');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const ws = mkdtempSync(join(tmpdir(), 'mca-rest-errors-ws-'));
    process.env.MCA_WORKSPACE_PATH = ws;
    let message = '';
    try {
      await cloneRepo.handler({ owner: 'acme', repo: 'api' }, noTokenCtx);
    } catch (e) {
      message = (e as Error).message;
    } finally {
      delete process.env.MCA_WORKSPACE_PATH;
      rmSync(ws, { recursive: true, force: true });
    }
    expect(message.startsWith('[USER_NOT_AUTHENTICATED]')).toBe(true);
    expect(message).toContain('What to do:');
  });
});
