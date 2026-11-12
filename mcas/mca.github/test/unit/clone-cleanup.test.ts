import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  type PushFn,
  assessClone,
  cleanupClone,
  markCloneUsed,
  recordPush,
  runAgentCleanup,
  sweepClones,
} from '../../src/lib/clone-cleanup';
import { withRepoLock } from '../../src/lib/repo-lock';
import { cloneRepo, gitCleanup, gitStatus } from '../../src/tools';

const TOKEN = 'gho_FAKEtoken1234567890abcd';
const asAgent = (agentId: string) =>
  ({
    getUserSecrets: async () => ({ USER_ACCESS_TOKEN: TOKEN, USER_LOGIN: 'octo' }),
    getSystemSecrets: async () => ({}),
    execution: { agentId, userId: 'user_1', appId: 'app_gh' },
  }) as never;

const DAY = 24 * 60 * 60 * 1000;
let workspace: string;
let originDir: string;
let bare: string;
const env = { ...process.env };

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', env: process.env }).trim();
}

const localPush: PushFn = async (repoPath, src, dst) => {
  try {
    git(repoPath, ['push', '-q', 'origin', `${src}:refs/heads/${dst}`]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};
const failingPush: PushFn = async () => ({ ok: false, error: 'remote: refused' });

const savedBranches = () =>
  git(bare, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teros/saved'])
    .split('\n')
    .filter(Boolean);

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mca-cleanup-ws-'));
  originDir = mkdtempSync(join(tmpdir(), 'mca-cleanup-origin-'));
  process.env.MCA_WORKSPACE_PATH = workspace;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'T';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@example.com';
  delete process.env.MCA_GIT_CLONE_TTL_DAYS;
  delete process.env.MCA_GIT_SAVE_WORK;
  const work = join(originDir, 'work');
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  writeFileSync(join(work, 'README.md'), '# api\n');
  git(work, ['add', '.']);
  git(work, ['commit', '-qm', 'init']);
  bare = join(originDir, 'api.git');
  execFileSync('git', ['clone', '-q', '--bare', work, bare]);
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.file://${bare}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/acme/api.git';
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(originDir, { recursive: true, force: true });
});

async function agentClone(agent = 'agent_a'): Promise<string> {
  const r = (await cloneRepo.handler({ owner: 'acme', repo: 'api' }, asAgent(agent))) as { path: string };
  return r.path;
}

const idle = (path: string, days: number) => markCloneUsed(path, new Date(Date.now() - days * DAY));

describe('what a clone holds (gh-scope-4)', () => {
  it('a clean clone whose branches are all on GitHub has nothing to save', async () => {
    const path = await agentClone();
    expect((await assessClone(path)).unsaved).toEqual([]);
  });

  it('lists every kind of unsaved work', async () => {
    const path = await agentClone();
    writeFileSync(join(path, 'README.md'), 'changed\n');
    git(path, ['stash', '-q']);
    git(path, ['checkout', '-qb', 'local-only']);
    writeFileSync(join(path, 'b.txt'), 'b\n');
    git(path, ['add', '.']);
    git(path, ['commit', '-qm', 'local']);
    writeFileSync(join(path, 'untracked.txt'), 'u\n');
    const { unsaved } = await assessClone(path);
    expect(unsaved.join(' | ')).toMatch(/stash/);
    expect(unsaved.join(' | ')).toMatch(/not on GitHub/);
    expect(unsaved.join(' | ')).toMatch(/uncommitted|untracked/);
  });

  it('a pushed branch whose PR was merged and deleted on GitHub counts as saved', async () => {
    const path = await agentClone();
    git(path, ['checkout', '-qb', 'feat']);
    writeFileSync(join(path, 'f.txt'), 'f\n');
    git(path, ['add', '.']);
    git(path, ['commit', '-qm', 'feat']);
    git(path, ['push', '-q', '-u', 'origin', 'feat']);
    recordPush(path, 'feat', git(path, ['rev-parse', 'HEAD']));
    execFileSync('git', ['-C', bare, 'branch', '-D', 'feat']);
    git(path, ['fetch', '-q', '--prune']);
    expect((await assessClone(path)).unsaved.length).toBeGreaterThan(0);
    expect((await assessClone(path, async () => 'merged')).unsaved).toEqual([]);
  });
});

describe('cleanupClone saves unsaved work to a branch on origin, then removes the clone (gh-scope-4)', () => {
  it('a clean pushed clone is just removed', async () => {
    const path = await agentClone();
    const r = await cleanupClone(path, { context: asAgent('agent_a'), push: localPush });
    expect(r.removed).toBe(true);
    expect(r.savedBranches ?? []).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(savedBranches()).toEqual([]);
  });

  it('uncommitted and untracked work is committed to teros/saved/<agent>/<branch>-<date>, pushed, and the clone removed', async () => {
    const path = await agentClone();
    const mainBefore = git(bare, ['rev-parse', 'main']);
    writeFileSync(join(path, 'README.md'), 'changed\n');
    writeFileSync(join(path, 'notes.txt'), 'new file\n');
    const r = await cleanupClone(path, { context: asAgent('agent_a'), push: localPush });
    expect(r.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
    const [branch] = savedBranches();
    expect(branch).toMatch(/^teros\/saved\/agent_a\/main-\d{8}-\d{4}$/);
    expect(git(bare, ['show', `${branch}:notes.txt`])).toBe('new file');
    expect(git(bare, ['show', `${branch}:README.md`])).toBe('changed');
    expect(git(bare, ['rev-parse', 'main'])).toBe(mainBefore);
  });

  it('each stash becomes its own commit', async () => {
    const path = await agentClone();
    writeFileSync(join(path, 'README.md'), 'stashed edit\n');
    git(path, ['stash', '-q']);
    const r = await cleanupClone(path, { context: asAgent('agent_a'), push: localPush });
    expect(r.removed).toBe(true);
    const [branch] = savedBranches();
    expect(git(bare, ['log', '--format=%s', branch])).toMatch(/stash/i);
    expect(git(bare, ['show', `${branch}:README.md`])).toBe('stashed edit');
  });

  it('a rebase in progress is aborted, noted, and the work saved', async () => {
    const path = await agentClone();
    git(path, ['checkout', '-qb', 'feat']);
    writeFileSync(join(path, 'README.md'), 'feature version\n');
    git(path, ['commit', '-qam', 'feature edit']);
    const other = join(originDir, 'other');
    execFileSync('git', ['clone', '-q', bare, other]);
    writeFileSync(join(other, 'README.md'), 'main version\n');
    git(other, ['commit', '-qam', 'main edit']);
    git(other, ['push', '-q', 'origin', 'main']);
    git(path, ['fetch', '-q']);
    try {
      git(path, ['rebase', 'origin/main']);
    } catch {}
    expect(existsSync(join(path, '.git', 'rebase-merge')) || existsSync(join(path, '.git', 'rebase-apply'))).toBe(true);
    const r = await cleanupClone(path, { context: asAgent('agent_a'), push: localPush });
    expect(r.removed).toBe(true);
    const [branch] = savedBranches();
    expect(branch).toMatch(/^teros\/saved\/agent_a\/feat-/);
    expect(git(bare, ['log', '--format=%B', branch])).toMatch(/rebase/i);
    expect(git(bare, ['show', `${branch}:README.md`])).toBe('feature version');
  });

  it('a possible secret keeps the clone and nothing is pushed', async () => {
    const path = await agentClone();
    writeFileSync(join(path, 'deploy.pem'), '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n');
    const r = await cleanupClone(path, { context: asAgent('agent_a'), push: localPush });
    expect(r.removed).toBe(false);
    expect(r.reason).toMatch(/secret|private key/i);
    expect(existsSync(path)).toBe(true);
    expect(savedBranches()).toEqual([]);
  });

  it('a .env file keeps the clone', async () => {
    const path = await agentClone();
    writeFileSync(join(path, '.env'), 'API_URL=https://example.com\n');
    const r = await cleanupClone(path, { context: asAgent('agent_a'), push: localPush });
    expect(r.removed).toBe(false);
    expect(r.reason).toMatch(/\.env/);
  });

  it('a failed push keeps the clone and reports it', async () => {
    const path = await agentClone();
    writeFileSync(join(path, 'notes.txt'), 'work\n');
    const r = await cleanupClone(path, { context: asAgent('agent_a'), push: failingPush });
    expect(r.removed).toBe(false);
    expect(r.reason).toMatch(/push/i);
    expect(existsSync(path)).toBe(true);
  });

  it('never pushes to the default branch or an existing branch name', async () => {
    const path = await agentClone();
    const pushed: string[] = [];
    writeFileSync(join(path, 'notes.txt'), 'work\n');
    await cleanupClone(path, {
      context: asAgent('agent_a'),
      push: async (p, src, dst) => {
        pushed.push(dst);
        return localPush(p, src, dst);
      },
    });
    expect(pushed.length).toBe(1);
    expect(pushed.every((d) => d.startsWith('teros/saved/'))).toBe(true);
  });

  it('with MCA_GIT_SAVE_WORK=0 a clone with work is kept, as before', async () => {
    process.env.MCA_GIT_SAVE_WORK = '0';
    const path = await agentClone();
    writeFileSync(join(path, 'notes.txt'), 'work\n');
    const r = await cleanupClone(path, { context: asAgent('agent_a'), push: localPush });
    expect(r.removed).toBe(false);
    expect(r.reason).toMatch(/untracked|uncommitted/);
  });

  it('skips a clone whose lock is held', async () => {
    const path = await agentClone();
    let release!: () => void;
    const held = withRepoLock(path, 'git-push', () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 50));
    const r = await cleanupClone(path, { context: asAgent('agent_a'), push: localPush });
    expect(r.removed).toBe(false);
    expect(r.reason).toMatch(/in use/);
    release();
    await held;
  });

  it("the agent's next call says where the work was saved, and the clone comes back by itself", async () => {
    const path = await agentClone();
    writeFileSync(join(path, 'notes.txt'), 'work\n');
    await cleanupClone(path, { context: asAgent('agent_a'), push: localPush });
    const status = (await gitStatus.handler({ owner: 'acme', repo: 'api' }, asAgent('agent_a'))) as {
      branch: string;
      cleanup_note?: string;
    };
    expect(status.branch).toBe('main');
    expect(status.cleanup_note).toMatch(/saved to branch teros\/saved\/agent_a\/main-/);
    expect(existsSync(path)).toBe(true);
  });
});

describe('when cleanup runs (gh-scope-4)', () => {
  it('the sweep removes clean clones idle longer than the TTL and keeps recent ones', async () => {
    const old = await agentClone('agent_a');
    const recent = await agentClone('agent_b');
    idle(old, 8);
    idle(recent, 2);
    await sweepClones();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('honours MCA_GIT_CLONE_TTL_DAYS', async () => {
    process.env.MCA_GIT_CLONE_TTL_DAYS = '1';
    const path = await agentClone();
    idle(path, 2);
    await sweepClones();
    expect(existsSync(path)).toBe(false);
  });

  it('the sweep has no token, so an idle clone with work waits; the agent call saves it', async () => {
    const path = await agentClone();
    writeFileSync(join(path, 'notes.txt'), 'work\n');
    idle(path, 30);
    await sweepClones();
    expect(existsSync(path)).toBe(true);
    await runAgentCleanup(asAgent('agent_a'), { push: localPush });
    expect(existsSync(path)).toBe(false);
    expect(savedBranches().length).toBe(1);
  });

  it('old shared clones are swept when clean', async () => {
    const shared = join(workspace, 'acme', 'api');
    execFileSync('git', ['clone', '-q', 'https://github.com/acme/api.git', shared], { env: process.env });
    idle(shared, 30);
    await sweepClones();
    expect(existsSync(shared)).toBe(false);
  });

  it("a clone whose pushed PR was merged is removed on the agent's next call, even before the TTL", async () => {
    const path = await agentClone();
    git(path, ['checkout', '-qb', 'feat']);
    writeFileSync(join(path, 'f.txt'), 'f\n');
    git(path, ['add', '.']);
    git(path, ['commit', '-qm', 'feat']);
    git(path, ['push', '-q', '-u', 'origin', 'feat']);
    recordPush(path, 'feat', git(path, ['rev-parse', 'HEAD']));
    await runAgentCleanup(asAgent('agent_a'), { push: localPush, prState: async () => 'merged' });
    expect(existsSync(path)).toBe(false);
    expect(savedBranches()).toEqual([]);
  });
});

describe('the PR-merged trigger leaves clones with unsaved work alone (gh-scope-4 review)', () => {
  it('a merged PR does not save or remove a clone that has new uncommitted work', async () => {
    const path = await agentClone();
    git(path, ['checkout', '-qb', 'feat']);
    writeFileSync(join(path, 'f.txt'), 'f\n');
    git(path, ['add', '.']);
    git(path, ['commit', '-qm', 'feat']);
    git(path, ['push', '-q', '-u', 'origin', 'feat']);
    recordPush(path, 'feat', git(path, ['rev-parse', 'HEAD']));
    writeFileSync(join(path, 'after-merge.txt'), 'still working\n');
    await runAgentCleanup(asAgent('agent_a'), { push: localPush, prState: async () => 'merged' });
    expect(existsSync(path)).toBe(true);
    expect(savedBranches()).toEqual([]);
  });
});

describe('git-cleanup (gh-scope-4)', () => {
  it('frees the agent own clone when it is clean', async () => {
    const path = await agentClone();
    const r = (await gitCleanup.handler({ owner: 'acme', repo: 'api' }, asAgent('agent_a'))) as { removed: boolean };
    expect(r.removed).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
