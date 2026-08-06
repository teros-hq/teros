import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  gitBlame,
  gitCherryPick,
  gitConfig,
  gitFetch,
  gitMerge,
  gitRebase,
  gitRemote,
  gitReset,
  gitStash,
  gitTag,
} from '../../src/tools';

interface MockContext {
  getUserSecrets: () => Promise<Record<string, string>>;
  getSystemSecrets: () => Promise<Record<string, string>>;
}

const ctx: MockContext = {
  getUserSecrets: async () => ({
    USER_ACCESS_TOKEN: 'ghu_test_user_access_token',
    USER_REFRESH_TOKEN: 'ghr_test',
    USER_TOKEN_EXPIRES_AT: new Date(Date.now() + 3_600_000).toISOString(),
    USER_LOGIN: 'tester',
    INSTALLATION_ID: '1',
  }),
  getSystemSecrets: async () => ({
    GITHUB_APP_ID: '1',
    GITHUB_APP_CLIENT_ID: 'Iv23test',
    GITHUB_APP_CLIENT_SECRET: 'cs_test',
    GITHUB_APP_PRIVATE_KEY: 'placeholder',
    GITHUB_APP_SLUG: 'teros',
  }),
};

let workspace: string;
let repoPath: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mca-git-p2p3-'));
  process.env.MCA_WORKSPACE_PATH = workspace;
  repoPath = join(workspace, 'sample');
  execSync(`mkdir -p ${repoPath}`);
  execSync(`git -C ${repoPath} init -q -b main`);
  execSync(`git -C ${repoPath} config user.email "test@example.com"`);
  execSync(`git -C ${repoPath} config user.name "Test User"`);
  writeFileSync(join(repoPath, 'README.md'), '# Sample\nLine 2\nLine 3\n');
  execSync(`git -C ${repoPath} add README.md && git -C ${repoPath} commit -q -m "init"`);
});

/**
 * Setup helper: creates two divergent branches that conflict on the same line
 * of README.md. Returns the names of both branches.
 *
 *   main:    "# Sample\nLine 2\nLine 3\n"   (initial)
 *   feat-a:  changes line 2 to "Line 2 — A"
 *   feat-b:  changes line 2 to "Line 2 — B"
 *
 * After this, a `git merge feat-a feat-b` or rebase/cherry-pick from feat-b
 * onto feat-a conflicts on line 2.
 */
function setupConflictingBranches() {
  execSync(`git -C ${repoPath} checkout -q -b feat-a`);
  writeFileSync(join(repoPath, 'README.md'), '# Sample\nLine 2 — A\nLine 3\n');
  execSync(`git -C ${repoPath} commit -q -am "A: change line 2"`);

  execSync(`git -C ${repoPath} checkout -q main`);
  execSync(`git -C ${repoPath} checkout -q -b feat-b`);
  writeFileSync(join(repoPath, 'README.md'), '# Sample\nLine 2 — B\nLine 3\n');
  execSync(`git -C ${repoPath} commit -q -am "B: change line 2"`);
  return { branchA: 'feat-a', branchB: 'feat-b' };
}

afterEach(() => {
  delete process.env.MCA_WORKSPACE_PATH;
  rmSync(workspace, { recursive: true, force: true });
});

// ============================================================================
// git-stash
// ============================================================================

describe('git-stash', () => {
  it('lists empty when no stash entries', async () => {
    const r = (await gitStash.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(r.entries).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('push + list + pop cycle', async () => {
    writeFileSync(join(repoPath, 'README.md'), '# Sample v2\n');
    const push = (await gitStash.handler(
      { repoPath, action: 'push', message: 'wip' },
      ctx as never,
    )) as Record<string, any>;
    expect(push.action).toBe('push');

    const list = (await gitStash.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(list.total).toBe(1);
    expect(list.entries[0].description).toContain('wip');

    await gitStash.handler({ repoPath, action: 'pop' }, ctx as never);
    const after = execSync(`git -C ${repoPath} stash list`, { encoding: 'utf-8' }).trim();
    expect(after).toBe('');
  });
});

// ============================================================================
// git-merge
// ============================================================================

describe('git-merge', () => {
  it('fast-forward merges another branch', async () => {
    execSync(`git -C ${repoPath} checkout -q -b feature`);
    writeFileSync(join(repoPath, 'feature.ts'), 'export const x = 1\n');
    execSync(`git -C ${repoPath} add feature.ts && git -C ${repoPath} commit -q -m "feat: x"`);
    execSync(`git -C ${repoPath} checkout -q main`);
    const r = (await gitMerge.handler(
      { repoPath, target: 'feature' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.branch).toBe('main');
    expect(r.target).toBe('feature');
  });
});

// ============================================================================
// git-reset
// ============================================================================

describe('git-reset', () => {
  it('mixed reset unstages changes but keeps working tree', async () => {
    writeFileSync(join(repoPath, 'staged.txt'), 'x');
    execSync(`git -C ${repoPath} add staged.txt`);
    await gitReset.handler({ repoPath, mode: 'mixed' }, ctx as never);
    const status = execSync(`git -C ${repoPath} status --porcelain`, { encoding: 'utf-8' });
    expect(status).toContain('?? staged.txt'); // file still on disk, no longer staged
  });

  it('soft reset moves HEAD but keeps everything else', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'a');
    execSync(`git -C ${repoPath} add a.txt && git -C ${repoPath} commit -q -m "extra"`);
    await gitReset.handler({ repoPath, mode: 'soft', target: 'HEAD~1' }, ctx as never);
    const status = execSync(`git -C ${repoPath} status --porcelain`, { encoding: 'utf-8' });
    expect(status).toContain('A  a.txt'); // staged
  });
});

// ============================================================================
// git-config
// ============================================================================

describe('git-config', () => {
  it('rejects keys not in the whitelist', async () => {
    await expect(
      gitConfig.handler({ repoPath, action: 'set', key: 'credential.helper', value: '/tmp/x' }, ctx as never),
    ).rejects.toThrow(/not whitelisted/);
  });

  it('set + get for user.email', async () => {
    await gitConfig.handler(
      { repoPath, action: 'set', key: 'user.email', value: 'bot@teros.ai' },
      ctx as never,
    );
    const r = (await gitConfig.handler(
      { repoPath, action: 'get', key: 'user.email' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.value).toBe('bot@teros.ai');
  });

  it('list returns only whitelisted keys', async () => {
    const r = (await gitConfig.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(r.entries['user.email']).toBeDefined();
    // Internal keys like core.repositoryformatversion are filtered out.
    expect(r.entries['core.repositoryformatversion']).toBeUndefined();
  });
});

// ============================================================================
// git-tag
// ============================================================================

describe('git-tag', () => {
  it('create + list + delete', async () => {
    await gitTag.handler(
      { repoPath, action: 'create', name: 'v0.1.0', message: 'release' },
      ctx as never,
    );
    const list = (await gitTag.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(list.tags).toContain('v0.1.0');
    await gitTag.handler({ repoPath, action: 'delete', name: 'v0.1.0' }, ctx as never);
    const after = (await gitTag.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(after.tags).not.toContain('v0.1.0');
  });
});

// ============================================================================
// git-remote
// ============================================================================

describe('git-remote', () => {
  it('add + list + remove', async () => {
    await gitRemote.handler(
      { repoPath, action: 'add', name: 'upstream', url: 'https://github.com/x/y.git' },
      ctx as never,
    );
    const list = (await gitRemote.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(list.remotes.find((r: any) => r.name === 'upstream')).toBeDefined();
    await gitRemote.handler({ repoPath, action: 'remove', name: 'upstream' }, ctx as never);
    const after = (await gitRemote.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(after.remotes.find((r: any) => r.name === 'upstream')).toBeUndefined();
  });
});

// ============================================================================
// git-blame
// ============================================================================

describe('git-blame', () => {
  it('returns per-line attribution', async () => {
    const r = (await gitBlame.handler(
      { repoPath, path: 'README.md' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.total).toBe(3);
    expect(r.lines[0].author).toBe('Test User');
    expect(r.lines[0].content).toBe('# Sample');
    expect(r.lines[0].sha).toMatch(/^[a-f0-9]{40}$/);
  });
});

// ============================================================================
// Conflict paths — verify the classifier returns GIT_CONFLICT on rebase and
// cherry-pick, not just on merge.
// ============================================================================

describe('git-merge — conflict path', () => {
  it('throws GIT_CONFLICT when merging diverging branches with same-line edits', async () => {
    setupConflictingBranches();
    execSync(`git -C ${repoPath} checkout -q feat-a`);
    await expect(
      gitMerge.handler({ repoPath, target: 'feat-b' }, ctx as never),
    ).rejects.toThrow(/GIT_CONFLICT/);
  });
});

describe('git-rebase — conflict path', () => {
  it('throws GIT_CONFLICT when rebasing onto a diverging branch', async () => {
    setupConflictingBranches();
    execSync(`git -C ${repoPath} checkout -q feat-b`);
    await expect(
      gitRebase.handler({ repoPath, onto: 'feat-a' }, ctx as never),
    ).rejects.toThrow(/GIT_CONFLICT/);
  });

  it('mode: abort cleans up an in-progress rebase', async () => {
    setupConflictingBranches();
    execSync(`git -C ${repoPath} checkout -q feat-b`);
    // Drive it into a conflict, then abort.
    await gitRebase.handler({ repoPath, onto: 'feat-a' }, ctx as never).catch(() => {});
    const r = (await gitRebase.handler({ repoPath, mode: 'abort' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(r.mode).toBe('abort');
    // After abort the tree should be clean and on feat-b again.
    const status = execSync(`git -C ${repoPath} status --porcelain`, { encoding: 'utf-8' });
    expect(status.trim()).toBe('');
  });
});

describe('git-cherry-pick — conflict path', () => {
  it('throws GIT_CONFLICT when cherry-picking a commit that conflicts', async () => {
    setupConflictingBranches();
    execSync(`git -C ${repoPath} checkout -q feat-a`);
    const bSha = execSync(`git -C ${repoPath} rev-parse feat-b`, { encoding: 'utf-8' }).trim();
    await expect(
      gitCherryPick.handler({ repoPath, commits: [bSha] }, ctx as never),
    ).rejects.toThrow(/GIT_CONFLICT/);
  });

  it('mode: abort cancels an in-progress cherry-pick', async () => {
    setupConflictingBranches();
    execSync(`git -C ${repoPath} checkout -q feat-a`);
    const bSha = execSync(`git -C ${repoPath} rev-parse feat-b`, { encoding: 'utf-8' }).trim();
    await gitCherryPick.handler({ repoPath, commits: [bSha] }, ctx as never).catch(() => {});
    const r = (await gitCherryPick.handler({ repoPath, mode: 'abort' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(r.mode).toBe('abort');
    const status = execSync(`git -C ${repoPath} status --porcelain`, { encoding: 'utf-8' });
    expect(status.trim()).toBe('');
  });
});

// ============================================================================
// git-fetch — sync without merge (replaces gh pr checkout)
// ============================================================================

describe('git-fetch', () => {
  it('throws a classifiable error when no remote is configured', async () => {
    // No remote → git emits "No remote configured" or similar; we only assert
    // the tool surfaces a clean error (not crash) without an upstream.
    const result = await gitFetch
      .handler({ repoPath }, ctx as never)
      .then(() => 'ok')
      .catch((e) => (e as Error).message);
    expect(result).not.toBe('ok');
  });
});
