import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { classifyGitError } from '../../src/tools/_git-error';
import { gitBatchCommit, gitCommit } from '../../src/tools';

const ctx = {
  getUserSecrets: async () => ({ USER_ACCESS_TOKEN: 'ghu_identity_test_token', USER_LOGIN: 'octo' }),
  getSystemSecrets: async () => ({ GITHUB_APP_SLUG: 'teros' }),
  execution: { agentId: undefined, userId: 'user_1', appId: 'app_gh' },
} as never;

let workspace: string;
let repoPath: string;
let home: string;
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
let userCalls = 0;

function git(args: string[]) {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf-8', env: process.env }).trim();
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mca-ident-ws-'));
  home = mkdtempSync(join(tmpdir(), 'mca-ident-home-'));
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tuseConfigOnly = true\n');
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = join(home, '.gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.MCA_WORKSPACE_PATH = workspace;
  repoPath = join(workspace, 'acme', 'api');
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath], { env: process.env });
  writeFileSync(join(repoPath, 'README.md'), '# api\n');
  userCalls = 0;
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).endsWith('/user')) {
      userCalls++;
      return new Response(JSON.stringify({ id: 4242, login: 'octo', name: 'Octo Cat' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('commits are authored as the connected GitHub user (007)', () => {
  it('git-commit works with no git identity configured anywhere', async () => {
    git(['add', 'README.md']);
    await gitCommit.handler({ repoPath, message: 'first' }, ctx);
    expect(git(['log', '-1', '--format=%an <%ae>|%cn <%ce>'])).toBe(
      'Octo Cat <4242+octo@users.noreply.github.com>|Octo Cat <4242+octo@users.noreply.github.com>',
    );
  });

  it('an identity an agent stored in the clone config does not override the user', async () => {
    git(['config', 'user.name', 'Gale GitHub']);
    git(['config', 'user.email', 'gale@teros.ai']);
    rmSync(join(repoPath, 'README.md'));
    await gitBatchCommit.handler(
      { repoPath, message: 'batch', changes: [{ action: 'create', path: 'README.md', content: '# api v2\n' }] },
      ctx,
    );
    expect(git(['log', '-1', '--format=%an <%ae>'])).toBe('Octo Cat <4242+octo@users.noreply.github.com>');
  });

  it('GET /user is asked once per token, not on every commit', async () => {
    git(['add', 'README.md']);
    await gitCommit.handler({ repoPath, message: 'one' }, ctx);
    writeFileSync(join(repoPath, 'b.txt'), 'b\n');
    git(['add', 'b.txt']);
    await gitCommit.handler({ repoPath, message: 'two' }, ctx);
    expect(userCalls).toBeLessThanOrEqual(1);
  });

  it('a missing identity is classified, not GIT_UNKNOWN', () => {
    const classified = classifyGitError({
      code: 128,
      stdout: '',
      stderr:
        "Author identity unknown\n\n*** Please tell me who you are.\n\nfatal: unable to auto-detect email address (got 'root@e91836e2ba49.(none)')",
      command: 'commit',
    });
    expect(classified.code).toBe('GIT_IDENTITY_MISSING');
  });
});
