import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  GitPathError,
  assertIsRepo,
  getWorkspacePath,
  parseGitDiffNumstat,
  parseGitLogPretty,
  parseGitStatusPorcelain,
  resolveRepoPath,
  runGit,
} from '../../src/lib/git-local';

let workspace: string;
let repoPath: string;

function setupRepo() {
  workspace = mkdtempSync(join(tmpdir(), 'mca-git-test-ws-'));
  process.env.MCA_WORKSPACE_PATH = workspace;
  repoPath = join(workspace, 'sample-repo');
  execSync(`mkdir -p ${repoPath}`);
  execSync(`git -C ${repoPath} init -q -b main`);
  execSync(`git -C ${repoPath} config user.email "test@example.com"`);
  execSync(`git -C ${repoPath} config user.name "Test User"`);
  writeFileSync(join(repoPath, 'README.md'), '# Sample\n');
  execSync(`git -C ${repoPath} add README.md`);
  execSync(`git -C ${repoPath} commit -q -m "init"`);
}

function cleanupRepo() {
  delete process.env.MCA_WORKSPACE_PATH;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}

describe('getWorkspacePath', () => {
  beforeEach(setupRepo);
  afterEach(cleanupRepo);

  it('honours MCA_WORKSPACE_PATH when it exists', () => {
    expect(getWorkspacePath()).toBe(workspace);
  });
});

describe('resolveRepoPath', () => {
  beforeEach(setupRepo);
  afterEach(cleanupRepo);

  it('resolves an absolute repoPath as-is', () => {
    expect(resolveRepoPath({ repoPath })).toBe(repoPath);
  });

  it('resolves a relative repoPath against the workspace', () => {
    expect(resolveRepoPath({ repoPath: 'sample-repo' })).toBe(repoPath);
  });

  it('resolves `<workspace>/<repo>` when only owner+repo are given', () => {
    expect(resolveRepoPath({ owner: 'x', repo: 'sample-repo' })).toBe(repoPath);
  });

  it('throws when neither repoPath nor repo are provided', () => {
    expect(() => resolveRepoPath({})).toThrow(GitPathError);
  });

  it('rejects paths that escape the workspace', () => {
    expect(() => resolveRepoPath({ repoPath: '../../../etc/passwd' })).toThrow(GitPathError);
  });
});

describe('assertIsRepo', () => {
  beforeEach(setupRepo);
  afterEach(cleanupRepo);

  it('passes for a valid git repo', () => {
    expect(() => assertIsRepo(repoPath)).not.toThrow();
  });

  it('throws for a directory without .git/', () => {
    expect(() => assertIsRepo(workspace)).toThrow(GitPathError);
  });
});

describe('runGit', () => {
  beforeEach(setupRepo);
  afterEach(cleanupRepo);

  it('returns stdout/stderr/code', () => {
    const r = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('main');
  });

  it('captures non-zero exit without throwing', () => {
    const r = runGit(repoPath, ['checkout', 'definitely-not-a-branch']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('did not match');
  });

  it('sanitises GitHub token-shaped strings from output', () => {
    // Simulate an output containing what looks like a token. We can't make git
    // emit one easily, so we exercise the sanitiser path by setting a remote
    // URL with a token and then asking git to print the config.
    execSync(
      `git -C ${repoPath} remote add fake https://x-access-token:ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/x/y.git`,
    );
    const r = runGit(repoPath, ['remote', 'get-url', 'fake']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(r.stdout).toContain('REDACTED');
  });
});

describe('parseGitStatusPorcelain', () => {
  it('parses a clean working tree', () => {
    const out = '# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n';
    const r = parseGitStatusPorcelain(out);
    expect(r.branch).toBe('main');
    expect(r.upstream).toBe('origin/main');
    expect(r.ahead).toBe(0);
    expect(r.behind).toBe(0);
    expect(r.totalChanges).toBe(0);
  });

  it('parses ordinary entry, untracked, and conflict', () => {
    // porcelain v2 reference:
    //   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>             (ordinary)
    //   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>   (unmerged)
    const out = [
      '# branch.head feature',
      '1 .M N... 100644 100644 100644 abc def src/index.ts',
      '? notes.md',
      'u UU N... 100644 100644 100644 100644 a b c conflicted.ts',
    ].join('\n');
    const r = parseGitStatusPorcelain(out);
    expect(r.branch).toBe('feature');
    expect(r.modified.map((e) => e.path)).toEqual(['src/index.ts']);
    expect(r.untracked.map((e) => e.path)).toEqual(['notes.md']);
    expect(r.conflicted.map((e) => e.path)).toEqual(['conflicted.ts']);
    expect(r.totalChanges).toBe(3);
  });

  it('detects detached HEAD', () => {
    const r = parseGitStatusPorcelain('# branch.head (detached)\n');
    expect(r.detached).toBe(true);
    expect(r.branch).toBeNull();
  });
});

describe('parseGitLogPretty', () => {
  it('parses multiple commits separated by record separator', () => {
    const a = ['sha1', 'sha1', 'Ann', 'a@x.com', '2026-01-01T10:00:00Z', 'subject1', ''].join('\x1f');
    const b = ['sha2', 'sha2', 'Bob', 'b@x.com', '2026-01-02T10:00:00Z', 'subject2', 'body line'].join('\x1f');
    const out = `${a}\x1e${b}\x1e`;
    const r = parseGitLogPretty(out);
    expect(r.length).toBe(2);
    expect(r[0]?.author).toBe('Ann');
    expect(r[1]?.subject).toBe('subject2');
    expect(r[1]?.body).toBe('body line');
  });

  it('returns empty array on empty input', () => {
    expect(parseGitLogPretty('')).toEqual([]);
  });
});

describe('parseGitDiffNumstat', () => {
  it('parses additions, deletions, and binary placeholders', () => {
    const out = '10\t2\tsrc/a.ts\n-\t-\tassets/logo.png\n';
    const r = parseGitDiffNumstat(out);
    expect(r.length).toBe(2);
    expect(r[0]).toEqual({ path: 'src/a.ts', additions: 10, deletions: 2 });
    expect(r[1]).toEqual({ path: 'assets/logo.png', additions: 0, deletions: 0 });
  });

  it('detects renames in the brace form', () => {
    const r = parseGitDiffNumstat('3\t1\tsrc/{old.ts => new.ts}\n');
    expect(r[0]?.path).toBe('src/new.ts');
    expect(r[0]?.origPath).toBe('src/old.ts');
  });
});
