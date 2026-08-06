import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { gitAdd, gitCheckout, gitCommit, gitStatus } from '../../src/tools';

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
let repoName: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mca-git-p0-'));
  process.env.MCA_WORKSPACE_PATH = workspace;
  repoName = 'sample';
  repoPath = join(workspace, repoName);
  execSync(`mkdir -p ${repoPath}`);
  execSync(`git -C ${repoPath} init -q -b main`);
  execSync(`git -C ${repoPath} config user.email "test@example.com"`);
  execSync(`git -C ${repoPath} config user.name "Test User"`);
  writeFileSync(join(repoPath, 'README.md'), '# Sample\n');
  execSync(`git -C ${repoPath} add README.md`);
  execSync(`git -C ${repoPath} commit -q -m "init"`);
});

afterEach(() => {
  delete process.env.MCA_WORKSPACE_PATH;
  rmSync(workspace, { recursive: true, force: true });
});

// ============================================================================
// git-status
// ============================================================================

describe('git-status', () => {
  it('returns clean tree on a fresh repo', async () => {
    const r = (await gitStatus.handler({ repoPath }, ctx as never)) as Record<string, any>;
    expect(r.repoPath).toBe(repoPath);
    expect(r.branch).toBe('main');
    expect(r.totalChanges).toBe(0);
    expect(r.modified).toEqual([]);
    expect(r.untracked).toEqual([]);
  });

  it('detects untracked files', async () => {
    writeFileSync(join(repoPath, 'new.txt'), 'hello\n');
    const r = (await gitStatus.handler({ repoPath }, ctx as never)) as Record<string, any>;
    expect(r.untracked.length).toBe(1);
    expect(r.untracked[0].path).toBe('new.txt');
  });

  it('throws GIT_NOT_A_REPO when path is not a repo', async () => {
    const notRepo = join(workspace, 'just-a-dir');
    execSync(`mkdir -p ${notRepo}`);
    await expect(gitStatus.handler({ repoPath: notRepo }, ctx as never)).rejects.toThrow(
      /Not a git repository/,
    );
  });

  it('resolves repoPath from `repo` arg when `repoPath` is omitted', async () => {
    const r = (await gitStatus.handler({ repo: repoName }, ctx as never)) as Record<string, any>;
    expect(r.repoPath).toBe(repoPath);
  });
});

// ============================================================================
// git-add
// ============================================================================

describe('git-add', () => {
  it('stages all changes by default', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'a');
    writeFileSync(join(repoPath, 'b.txt'), 'b');
    const r = (await gitAdd.handler({ repoPath }, ctx as never)) as Record<string, any>;
    expect(r.staged).toBeGreaterThanOrEqual(2);
    expect(r.stagedFiles).toContain('a.txt');
    expect(r.stagedFiles).toContain('b.txt');
  });

  it('stages only the given paths', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'a');
    writeFileSync(join(repoPath, 'b.txt'), 'b');
    const r = (await gitAdd.handler({ repoPath, paths: ['a.txt'] }, ctx as never)) as Record<
      string,
      any
    >;
    expect(r.stagedFiles).toEqual(['a.txt']);
  });

  it('with update:true only stages tracked file changes', async () => {
    // README.md is tracked; bump it. new.txt is untracked.
    writeFileSync(join(repoPath, 'README.md'), '# Sample v2\n');
    writeFileSync(join(repoPath, 'new.txt'), 'untracked\n');
    const r = (await gitAdd.handler({ repoPath, update: true }, ctx as never)) as Record<
      string,
      any
    >;
    expect(r.stagedFiles).toContain('README.md');
    expect(r.stagedFiles).not.toContain('new.txt');
  });
});

// ============================================================================
// git-commit
// ============================================================================

describe('git-commit', () => {
  it('creates a commit with the staged changes', async () => {
    writeFileSync(join(repoPath, 'feature.txt'), 'feat\n');
    execSync(`git -C ${repoPath} add feature.txt`);
    const r = (await gitCommit.handler(
      { repoPath, message: 'feat: add feature' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(r.shortSha.length).toBe(7);
    expect(r.branch).toBe('main');
    expect(r.message).toBe('feat: add feature');
  });

  it('throws GIT_NO_CHANGES when staging area is empty', async () => {
    await expect(
      gitCommit.handler({ repoPath, message: 'noop' }, ctx as never),
    ).rejects.toThrow(/GIT_NO_CHANGES/);
  });

  it('supports amend', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'a\n');
    execSync(`git -C ${repoPath} add a.txt`);
    execSync(`git -C ${repoPath} commit -q -m "original"`);
    writeFileSync(join(repoPath, 'a.txt'), 'a updated\n');
    execSync(`git -C ${repoPath} add a.txt`);
    const r = (await gitCommit.handler(
      { repoPath, message: 'amended', amend: true },
      ctx as never,
    )) as Record<string, any>;
    expect(r.amended).toBe(true);
    expect(r.message).toBe('amended');
  });

  it('rejects empty messages', async () => {
    await expect(
      gitCommit.handler({ repoPath, message: '   ' }, ctx as never),
    ).rejects.toThrow(/non-empty/);
  });
});

// ============================================================================
// git-checkout
// ============================================================================

describe('git-checkout', () => {
  it('switches to an existing branch', async () => {
    execSync(`git -C ${repoPath} checkout -q -b other`);
    execSync(`git -C ${repoPath} checkout -q main`);
    const r = (await gitCheckout.handler(
      { repoPath, target: 'other' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.branch).toBe('other');
  });

  it('creates a new branch when create:true', async () => {
    const r = (await gitCheckout.handler(
      { repoPath, target: 'feature/new', create: true },
      ctx as never,
    )) as Record<string, any>;
    expect(r.branch).toBe('feature/new');
    expect(r.created).toBe(true);
  });

  it('throws GIT_REF_NOT_FOUND when target does not exist', async () => {
    await expect(
      gitCheckout.handler({ repoPath, target: 'definitely-not-a-branch' }, ctx as never),
    ).rejects.toThrow(/GIT_REF_NOT_FOUND/);
  });
});
