import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  gitBatchCommit,
  gitDiff,
  gitListFiles,
  gitLog,
  gitMv,
  gitPull,
  gitReadFile,
  gitRm,
  gitWriteFile,
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
  workspace = mkdtempSync(join(tmpdir(), 'mca-git-p1-'));
  process.env.MCA_WORKSPACE_PATH = workspace;
  repoPath = join(workspace, 'sample');
  execSync(`mkdir -p ${repoPath}`);
  execSync(`git -C ${repoPath} init -q -b main`);
  execSync(`git -C ${repoPath} config user.email "test@example.com"`);
  execSync(`git -C ${repoPath} config user.name "Test User"`);
  writeFileSync(join(repoPath, 'README.md'), '# Sample\n');
  writeFileSync(join(repoPath, '.gitignore'), 'ignored.txt\n');
  execSync(`git -C ${repoPath} add .`);
  execSync(`git -C ${repoPath} commit -q -m "init"`);
});

afterEach(() => {
  delete process.env.MCA_WORKSPACE_PATH;
  rmSync(workspace, { recursive: true, force: true });
});

// ============================================================================
// git-rm
// ============================================================================

describe('git-rm', () => {
  it('removes tracked files', async () => {
    const r = (await gitRm.handler({ repoPath, paths: ['README.md'] }, ctx as never)) as Record<string, any>;
    expect(r.removed).toEqual(['README.md']);
    expect(existsSync(join(repoPath, 'README.md'))).toBe(false);
  });

  it('with cached:true keeps the file on disk', async () => {
    await gitRm.handler({ repoPath, paths: ['README.md'], cached: true }, ctx as never);
    expect(existsSync(join(repoPath, 'README.md'))).toBe(true);
  });
});

// ============================================================================
// git-mv
// ============================================================================

describe('git-mv', () => {
  it('renames a tracked file', async () => {
    const r = (await gitMv.handler(
      { repoPath, from: 'README.md', to: 'docs/README.md' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.from).toBe('README.md');
    expect(r.to).toBe('docs/README.md');
    expect(existsSync(join(repoPath, 'docs/README.md'))).toBe(true);
    expect(existsSync(join(repoPath, 'README.md'))).toBe(false);
  });
});

// ============================================================================
// git-read-file
// ============================================================================

describe('git-read-file', () => {
  it('reads from the working tree without ref', async () => {
    writeFileSync(join(repoPath, 'note.txt'), 'hello\n');
    const r = (await gitReadFile.handler({ repoPath, path: 'note.txt' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(r.content).toBe('hello\n');
    expect(r.ref).toBe('working-tree');
  });

  it('reads from a specific ref', async () => {
    writeFileSync(join(repoPath, 'README.md'), 'updated\n');
    execSync(`git -C ${repoPath} add README.md && git -C ${repoPath} commit -q -m bump`);
    const r = (await gitReadFile.handler(
      { repoPath, path: 'README.md', ref: 'HEAD~1' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.content).toContain('# Sample');
  });

  it('throws when file does not exist in working tree', async () => {
    await expect(
      gitReadFile.handler({ repoPath, path: 'nope.txt' }, ctx as never),
    ).rejects.toThrow(/GIT_REF_NOT_FOUND/);
  });
});

// ============================================================================
// git-write-file
// ============================================================================

describe('git-write-file', () => {
  it('writes new file and stages it', async () => {
    const r = (await gitWriteFile.handler(
      { repoPath, path: 'new.ts', content: 'export const x = 1\n' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.staged).toBe(true);
    expect(readFileSync(join(repoPath, 'new.ts'), 'utf-8')).toBe('export const x = 1\n');
  });

  it('creates parent directories', async () => {
    await gitWriteFile.handler(
      { repoPath, path: 'src/nested/foo.ts', content: 'foo' },
      ctx as never,
    );
    expect(existsSync(join(repoPath, 'src/nested/foo.ts'))).toBe(true);
  });

  it('with stage:false does not add to index', async () => {
    const r = (await gitWriteFile.handler(
      { repoPath, path: 'free.txt', content: 'x', stage: false },
      ctx as never,
    )) as Record<string, any>;
    expect(r.staged).toBe(false);
  });

  it('handles base64 binary content', async () => {
    const r = (await gitWriteFile.handler(
      { repoPath, path: 'bin.dat', content: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.bytes).toBe(3);
  });
});

// ============================================================================
// git-list-files
// ============================================================================

describe('git-list-files', () => {
  it('lists tracked + untracked, excluding ignored by default', async () => {
    writeFileSync(join(repoPath, 'extra.txt'), 'x');
    writeFileSync(join(repoPath, 'ignored.txt'), 'should not appear');
    const r = (await gitListFiles.handler({ repoPath }, ctx as never)) as Record<string, any>;
    expect(r.tracked).toContain('README.md');
    expect(r.untracked).toContain('extra.txt');
    expect(r.untracked).not.toContain('ignored.txt');
    expect(r.ignored).toEqual([]);
  });

  it('with includeIgnored:true returns ignored entries', async () => {
    writeFileSync(join(repoPath, 'ignored.txt'), 'x');
    const r = (await gitListFiles.handler(
      { repoPath, includeIgnored: true },
      ctx as never,
    )) as Record<string, any>;
    expect(r.ignored).toContain('ignored.txt');
  });
});

// ============================================================================
// git-diff
// ============================================================================

describe('git-diff', () => {
  it('diffs working tree vs HEAD by default', async () => {
    writeFileSync(join(repoPath, 'README.md'), '# Sample v2\n');
    const r = (await gitDiff.handler({ repoPath }, ctx as never)) as Record<string, any>;
    expect(r.totals.files).toBe(1);
    expect(r.totals.additions).toBeGreaterThan(0);
    expect(r.patch).toContain('+# Sample v2');
  });

  it('diffs staged area when from:staged', async () => {
    writeFileSync(join(repoPath, 'staged.txt'), 'staged\n');
    execSync(`git -C ${repoPath} add staged.txt`);
    const r = (await gitDiff.handler({ repoPath, from: 'staged' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(r.totals.files).toBe(1);
    expect(r.files[0].path).toBe('staged.txt');
  });
});

// ============================================================================
// git-log
// ============================================================================

describe('git-log', () => {
  it('returns parsed commit entries', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'a');
    execSync(`git -C ${repoPath} add a.txt && git -C ${repoPath} commit -q -m "feat: a"`);
    const r = (await gitLog.handler({ repoPath, limit: 5 }, ctx as never)) as Record<string, any>;
    expect(r.commits.length).toBeGreaterThanOrEqual(2);
    expect(r.commits[0].subject).toBe('feat: a');
    expect(r.commits[0].author).toBe('Test User');
    expect(r.commits[0].shortSha.length).toBe(7);
  });

  it('respects the limit parameter', async () => {
    const r = (await gitLog.handler({ repoPath, limit: 1 }, ctx as never)) as Record<string, any>;
    expect(r.commits.length).toBe(1);
  });
});

// ============================================================================
// git-batch-commit
// ============================================================================

describe('git-batch-commit', () => {
  it('applies create + update + delete + rename in a single commit', async () => {
    // Pre-existing tracked file to delete/rename.
    writeFileSync(join(repoPath, 'old.ts'), 'old');
    execSync(`git -C ${repoPath} add old.ts && git -C ${repoPath} commit -q -m "seed"`);
    writeFileSync(join(repoPath, 'doomed.txt'), 'goodbye');
    execSync(`git -C ${repoPath} add doomed.txt && git -C ${repoPath} commit -q -m "seed2"`);

    const r = (await gitBatchCommit.handler(
      {
        repoPath,
        message: 'refactor: atomic batch',
        changes: [
          { action: 'create', path: 'src/new.ts', content: 'export const x = 1\n' },
          { action: 'update', path: 'README.md', content: '# Sample v2\n' },
          { action: 'delete', path: 'doomed.txt' },
          { action: 'rename', path: 'src/renamed.ts', fromPath: 'old.ts' },
        ],
      },
      ctx as never,
    )) as Record<string, any>;

    expect(r.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(r.message).toBe('refactor: atomic batch');
    expect(r.changedFiles.length).toBe(4);

    // Verify the commit is a single new commit and the working tree is clean.
    const status = execSync(`git -C ${repoPath} status --porcelain`, { encoding: 'utf-8' });
    expect(status.trim()).toBe('');
  });

  it('rejects when the working tree is dirty', async () => {
    writeFileSync(join(repoPath, 'unfinished.txt'), 'wip\n');
    await expect(
      gitBatchCommit.handler(
        {
          repoPath,
          message: 'oops',
          changes: [{ action: 'create', path: 'whatever.ts', content: 'x' }],
        },
        ctx as never,
      ),
    ).rejects.toThrow(/GIT_DIRTY_TREE/);
  });

  it('rolls back on failure mid-batch', async () => {
    const preHead = execSync(`git -C ${repoPath} rev-parse HEAD`, { encoding: 'utf-8' }).trim();
    await expect(
      gitBatchCommit.handler(
        {
          repoPath,
          message: 'will fail',
          changes: [
            { action: 'create', path: 'good.ts', content: 'x' },
            // delete on a path that doesn't exist → throws mid-loop
            { action: 'delete', path: 'doesnt-exist.txt' },
          ],
        },
        ctx as never,
      ),
    ).rejects.toThrow();
    const postHead = execSync(`git -C ${repoPath} rev-parse HEAD`, { encoding: 'utf-8' }).trim();
    expect(postHead).toBe(preHead);
    expect(existsSync(join(repoPath, 'good.ts'))).toBe(false); // rolled back
  });
});

// ============================================================================
// git-pull (token resolution path — actual network requires a remote, skipped)
// ============================================================================

describe('git-pull', () => {
  it('throws on no upstream when called without remote/branch', async () => {
    // No remote configured at all → git emits a specific error. We just want
    // to confirm that token resolution + classification doesn't crash.
    const result = await gitPull
      .handler({ repoPath }, ctx as never)
      .then(() => 'ok')
      .catch((e) => (e as Error).message);
    expect(result).not.toBe('ok'); // must fail in some classifiable way
  });
});
