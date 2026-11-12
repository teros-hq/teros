import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  GIT_TIMEOUTS_MS,
  GitPathError,
  assertInsideWorkspace,
  assertIsRepo,
  assertRemoteIsGithubHttps,
  assertSafeRef,
  assertUpstreamRemoteIsGithubHttps,
  defaultGitTimeout,
  getWorkspacePath,
  gitSubcommand,
  parseGitDiffNumstat,
  parseGitLogPretty,
  parseGitStatusPorcelain,
  REF_RE,
  resolveRepoPath,
  runGit,
  stripEmbeddedCredentials,
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

describe('assertInsideWorkspace (shared containment — clone-repo destination parity)', () => {
  beforeEach(setupRepo);
  afterEach(cleanupRepo);

  it('resolves a relative target against the workspace and returns the absolute path', () => {
    expect(assertInsideWorkspace('sample-repo')).toBe(repoPath);
  });

  it('resolves a nested relative target (with dot-dot that stays inside)', () => {
    expect(assertInsideWorkspace('sample-repo/../other')).toBe(join(workspace, 'other'));
  });

  it('returns an absolute inside-workspace target normalised', () => {
    expect(assertInsideWorkspace(repoPath)).toBe(repoPath);
  });

  it('allows the workspace root itself', () => {
    expect(assertInsideWorkspace(workspace)).toBe(workspace);
    expect(assertInsideWorkspace('.')).toBe(workspace);
  });

  it('rejects an absolute target outside the workspace (/etc/evil)', () => {
    expect(() => assertInsideWorkspace('/etc/evil')).toThrow(GitPathError);
  });

  it('rejects a relative target that escapes via parent traversal', () => {
    expect(() => assertInsideWorkspace('../../outside')).toThrow(GitPathError);
  });

  it('rejects a prefix-sibling of the workspace (not fooled by shared prefix)', () => {
    expect(() => assertInsideWorkspace(`${workspace}-evil`)).toThrow(GitPathError);
  });

  it('throws the classified GIT_INVALID_PATH code', () => {
    try {
      assertInsideWorkspace('/etc/evil');
      throw new Error('expected assertInsideWorkspace to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GitPathError);
      expect((err as GitPathError).code).toBe('GIT_INVALID_PATH');
      expect((err as Error).message).toMatch(/outside the workspace/);
    }
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

  it('returns stdout/stderr/code', async () => {
    const r = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('main');
  });

  it('captures non-zero exit without throwing', async () => {
    const r = await runGit(repoPath, ['checkout', 'definitely-not-a-branch']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('did not match');
  });

  it('sanitises GitHub token-shaped strings from output', async () => {
    // Simulate an output containing what looks like a token. We can't make git
    // emit one easily, so we exercise the sanitiser path by setting a remote
    // URL with a token and then asking git to print the config.
    execSync(
      `git -C ${repoPath} remote add fake https://x-access-token:ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/x/y.git`,
    );
    const r = await runGit(repoPath, ['remote', 'get-url', 'fake']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(r.stdout).toContain('REDACTED');
  });
});

describe('stripEmbeddedCredentials (audit 2026-10-01)', () => {
  beforeEach(setupRepo);
  afterEach(cleanupRepo);

  it('rewrites a legacy remote URL with the token embedded', async () => {
    execSync(
      `git -C ${repoPath} remote add origin https://x-access-token:gho_FAKE1234567890abcdef@github.com/foo/bar.git`,
    );
    const stripped = await stripEmbeddedCredentials(repoPath);
    expect(stripped).toEqual([{ name: 'origin', cleanUrl: 'https://github.com/foo/bar.git' }]);
    // The .git/config on disk is now clean.
    const cfg = execSync(`git -C ${repoPath} remote get-url origin`, { encoding: 'utf-8' }).trim();
    expect(cfg).toBe('https://github.com/foo/bar.git');
  });

  it('is a no-op for clean remote URLs (incl. ssh://git@ username)', async () => {
    execSync(`git -C ${repoPath} remote add origin https://github.com/foo/bar.git`);
    execSync(`git -C ${repoPath} remote add mirror ssh://git@github.com/foo/bar.git`);
    expect(await stripEmbeddedCredentials(repoPath)).toEqual([]);
    const cfg = execSync(`git -C ${repoPath} remote get-url mirror`, { encoding: 'utf-8' }).trim();
    expect(cfg).toBe('ssh://git@github.com/foo/bar.git');
  });

  it('is idempotent: a second pass finds nothing to strip', async () => {
    execSync(
      `git -C ${repoPath} remote add origin https://x-access-token:gho_FAKE1234567890abcdef@github.com/foo/bar.git`,
    );
    await stripEmbeddedCredentials(repoPath);
    expect(await stripEmbeddedCredentials(repoPath)).toEqual([]);
  });

  it('never throws on a broken repo (best-effort hygiene)', async () => {
    const broken = join(workspace, 'broken-repo');
    execSync(`mkdir -p ${broken}/.git`);
    await expect(stripEmbeddedCredentials(broken)).resolves.toEqual([]);
    expect(await stripEmbeddedCredentials(broken)).toEqual([]);
  });
});

describe('assertRemoteIsGithubHttps (audit 2026-10-01)', () => {
  beforeEach(setupRepo);
  afterEach(cleanupRepo);

  it('passes for a clean github.com HTTPS remote', async () => {
    execSync(`git -C ${repoPath} remote add origin https://github.com/foo/bar.git`);
    await expect(assertRemoteIsGithubHttps(repoPath, 'origin')).resolves.toBeUndefined();
  });

  it('rejects a remote pointing at a foreign host', async () => {
    execSync(`git -C ${repoPath} remote add evil https://attacker.com/foo/bar.git`);
    await expect(assertRemoteIsGithubHttps(repoPath, 'evil')).rejects.toThrow(/GIT_REMOTE_NOT_GITHUB/);
  });

  it('rejects a remote URL with embedded credentials (fail closed)', async () => {
    execSync(
      `git -C ${repoPath} remote add origin https://x-access-token:gho_FAKE1234567890@github.com/foo/bar.git`,
    );
    await expect(assertRemoteIsGithubHttps(repoPath, 'origin')).rejects.toThrow(/GIT_REMOTE_NOT_GITHUB/);
  });

  it('rejects an ssh:// remote', async () => {
    execSync(`git -C ${repoPath} remote add origin ssh://git@github.com/foo/bar.git`);
    await expect(assertRemoteIsGithubHttps(repoPath, 'origin')).rejects.toThrow(/GIT_REMOTE_NOT_GITHUB/);
  });

  it('rejects an explicit push URL pointing at a foreign host', async () => {
    execSync(`git -C ${repoPath} remote add origin https://github.com/foo/bar.git`);
    execSync(`git -C ${repoPath} remote set-url --push origin https://attacker.com/foo/bar.git`);
    await expect(assertRemoteIsGithubHttps(repoPath, 'origin')).rejects.toThrow(/GIT_REMOTE_NOT_GITHUB/);
  });

  it('rejects a remote rewritten to a foreign host via url.insteadOf', async () => {
    execSync(`git -C ${repoPath} remote add origin https://github.com/foo/bar.git`);
    execSync(`git -C ${repoPath} config url."https://attacker.com/".insteadOf "https://github.com/"`);
    await expect(assertRemoteIsGithubHttps(repoPath, 'origin')).rejects.toThrow(/GIT_REMOTE_NOT_GITHUB/);
  });

  it('rejects a remote argument that is an inline URL (bypass attempt)', async () => {
    await expect(assertRemoteIsGithubHttps(repoPath, 'https://attacker.com/foo/bar.git')).rejects.toThrow(/GIT_INVALID_INPUT/);
  });

  it('rejects remote names with option/shell metacharacters', async () => {
    await expect(assertRemoteIsGithubHttps(repoPath, '--upload-pack=evil')).rejects.toThrow(
      /GIT_INVALID_INPUT/,
    );
    await expect(assertRemoteIsGithubHttps(repoPath, 'a b')).rejects.toThrow(/GIT_INVALID_INPUT/);
    await expect(assertRemoteIsGithubHttps(repoPath, '-x')).rejects.toThrow(/GIT_INVALID_INPUT/);
  });

  it('leaves unconfigured charset-valid names to git (no throw)', async () => {
    // `get-url` exits non-zero for an unknown remote — the guard defers to
    // git's own classifiable error instead of throwing.
    await expect(assertRemoteIsGithubHttps(repoPath, 'nope')).resolves.toBeUndefined();
  });
});

describe('assertUpstreamRemoteIsGithubHttps (audit 2026-10-01)', () => {
  beforeEach(setupRepo);
  afterEach(cleanupRepo);

  it('passes when the branch tracks a clean github.com remote', async () => {
    execSync(`git -C ${repoPath} remote add origin https://github.com/foo/bar.git`);
    // Write the tracking config directly — `--set-upstream-to` would require
    // the remote-tracking ref to exist (needs a fetch).
    execSync(`git -C ${repoPath} config branch.main.remote origin`);
    execSync(`git -C ${repoPath} config branch.main.merge refs/heads/main`);
    await expect(assertUpstreamRemoteIsGithubHttps(repoPath)).resolves.toBeUndefined();
  });

  it('rejects when the branch tracks a foreign-host remote', async () => {
    execSync(`git -C ${repoPath} remote add evil https://attacker.com/foo/bar.git`);
    execSync(`git -C ${repoPath} config branch.main.remote evil`);
    execSync(`git -C ${repoPath} config branch.main.merge refs/heads/main`);
    await expect(assertUpstreamRemoteIsGithubHttps(repoPath)).rejects.toThrow(/GIT_REMOTE_NOT_GITHUB/);
  });

  it('rejects a branch.<name>.remote that is itself a foreign URL', async () => {
    execSync(
      `git -C ${repoPath} config branch.main.remote https://attacker.com/foo/bar.git`,
    );
    execSync(`git -C ${repoPath} config branch.main.merge refs/heads/main`);
    await expect(assertUpstreamRemoteIsGithubHttps(repoPath)).rejects.toThrow(/GIT_REMOTE_NOT_GITHUB/);
  });

  it('is a no-op without upstream configuration', async () => {
    await expect(assertUpstreamRemoteIsGithubHttps(repoPath)).resolves.toBeUndefined();
  });
});

describe('assertSafeRef (audit 2026-10-01 — git-option injection hardening)', () => {
  it('accepts the ref/rev shapes the git tools legitimately use', () => {
    const legit = [
      'main',
      'feature/new',
      'HEAD',
      'HEAD~1',
      'HEAD^2',
      'HEAD~2^3',
      'v0.1.0',
      'v1.2.3-rc1',
      'refs/heads/main',
      'refs/tags/v1',
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', // full SHA
      'abc1234', // short SHA
      'main~1..main', // cherry-pick range
      'HEAD^{commit}',
      'HEAD@{1}',
      'stash@{0}',
      'release/+semver',
    ];
    for (const ref of legit) expect(REF_RE.test(ref), `legit ref rejected: ${ref}`).toBe(true);
  });

  it('rejects anything that git would parse as an option (leading dash)', () => {
    const attacks = [
      '--upload-pack=evil',
      '--exec=rm -rf /',
      '--sort=evil',
      '-b',
      '-x',
      '--',
      '-',
      '---x',
    ];
    for (const ref of attacks) expect(REF_RE.test(ref), `attack accepted: ${ref}`).toBe(false);
  });

  it('rejects non-ref-shaped values (spaces, shell metachars, URLs, traversal)', () => {
    const bad = [
      'a b',
      'a;b',
      'a$b',
      'a|b',
      'https://github.com/x', // ':' + scheme — blocks URL smuggling into a ref
      'HEAD:file',
      '../..',
      '.hidden',
      '',
    ];
    for (const ref of bad) expect(REF_RE.test(ref), `bad value accepted: ${ref}`).toBe(false);
  });

  it('throws GitPathError with GIT_INVALID_REF and names the offending field', () => {
    expect(() => assertSafeRef('--upload-pack=evil', 'target')).toThrow(GitPathError);
    expect(() => assertSafeRef('--upload-pack=evil', 'target')).toThrow(/GIT_INVALID_REF/);
    expect(() => assertSafeRef('--upload-pack=evil', 'target')).toThrow(/target/);
    expect(() => assertSafeRef('main', 'target')).not.toThrow();
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

// bug-git-github: runGit dropped spawnSync's `error`/`signal`, so a missing
// binary, an output overflow, an OOM kill and a real timeout all came back as
// `code: -1` → GIT_TIMEOUT. A fake `git` on PATH reproduces each shape fast.
describe('runGit abnormal termination (bug-git-github)', () => {
  let binDir: string;
  let fakeEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'mca-fake-git-'));
    // `git -C <dir> -c core.fsmonitor=false <cmd>` → $5 is the subcommand.
    writeFileSync(
      join(binDir, 'git'),
      [
        '#!/bin/sh',
        'case "$5" in',
        '  slow) echo "Receiving objects: 10%" >&2; sleep 30 ;;',
        '  flood) head -c 200000 /dev/zero ;;',
        '  oom) kill -9 $$ ;;',
        '  hook) sleep 30 & echo done ;;',
        '  *) echo ok ;;',
        'esac',
      ].join('\n'),
      { mode: 0o755 },
    );
    fakeEnv = { PATH: `${binDir}:/usr/bin:/bin` };
  });

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it('a timeout is reported as ETIMEDOUT with the stderr seen so far, and the child is killed', async () => {
    const started = Date.now();
    const r = await runGit(tmpdir(), ['slow'], { env: fakeEnv, timeout: 300 });
    expect(Date.now() - started).toBeLessThan(5_000); // process group killed, not waited out
    expect(r.code).toBe(-1);
    expect(r.error?.code).toBe('ETIMEDOUT');
    expect(r.stderr).toContain('Receiving objects');
    expect(r.timeoutMs).toBe(300);
    expect(r.command).toBe('slow');
  });

  it('a missing git binary is ENOENT, not a timeout', async () => {
    const r = await runGit(tmpdir(), ['status'], { env: { PATH: join(binDir, 'nothing-here') } });
    expect(r.code).toBe(-1);
    expect(r.error?.code).toBe('ENOENT');
  });

  it('output over maxBuffer is ENOBUFS, not a timeout', async () => {
    const r = await runGit(tmpdir(), ['flood'], { env: fakeEnv, maxBuffer: 1_000 });
    expect(r.code).toBe(-1);
    expect(r.error?.code).toBe('ENOBUFS');
  });

  it('a git killed by a signal reports the signal', async () => {
    const r = await runGit(tmpdir(), ['oom'], { env: fakeEnv });
    expect(r.code).toBe(-1);
    expect(r.signal).toBe('SIGKILL');
    expect(r.error).toBeUndefined();
  });

  it('returns once git exits even if something it started keeps the output pipes open', async () => {
    const started = Date.now();
    const r = await runGit(tmpdir(), ['hook'], { env: fakeEnv, timeout: 20_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('done');
    expect(r.error).toBeUndefined();
  });

  it('does not block the event loop while git runs (per-app container is shared by every agent)', async () => {
    let ticks = 0;
    const interval = setInterval(() => ticks++, 20);
    await runGit(tmpdir(), ['slow'], { env: fakeEnv, timeout: 400 });
    clearInterval(interval);
    expect(ticks).toBeGreaterThan(5);
  });

  it('never waits on a credential prompt (GIT_TERMINAL_PROMPT=0)', async () => {
    writeFileSync(join(binDir, 'git'), '#!/bin/sh\necho "prompt=$GIT_TERMINAL_PROMPT"\n', { mode: 0o755 });
    const r = await runGit(tmpdir(), ['push'], { env: fakeEnv });
    expect(r.stdout.trim()).toBe('prompt=0');
  });
});

describe('git timeouts per operation (bug-git-github)', () => {
  afterEach(() => {
    delete process.env.MCA_GIT_TIMEOUT_MS;
    delete process.env.MCA_GIT_NETWORK_TIMEOUT_MS;
  });

  it('finds the subcommand past global options', () => {
    expect(gitSubcommand(['-c', 'http.extraheader=AUTHORIZATION: basic x', 'push', '-u', 'origin'])).toBe('push');
    expect(gitSubcommand(['--no-pager', 'log'])).toBe('log');
    expect(gitSubcommand([])).toBe('');
  });

  it('network ops get the longer budget; both stay under the backend 120 s tool-call timeout', () => {
    for (const cmd of ['clone', 'fetch', 'pull', 'push']) {
      expect(defaultGitTimeout(['-c', 'a=b', cmd])).toBe(GIT_TIMEOUTS_MS.network);
    }
    expect(defaultGitTimeout(['status'])).toBe(GIT_TIMEOUTS_MS.local);
    expect(GIT_TIMEOUTS_MS.local).toBeGreaterThan(60_000);
    expect(GIT_TIMEOUTS_MS.network).toBeGreaterThan(GIT_TIMEOUTS_MS.local);
    expect(GIT_TIMEOUTS_MS.network).toBeLessThan(120_000);
  });

  it('ops can override the budgets per deployment', () => {
    process.env.MCA_GIT_TIMEOUT_MS = '5000';
    process.env.MCA_GIT_NETWORK_TIMEOUT_MS = '300000';
    expect(defaultGitTimeout(['status'])).toBe(5_000);
    expect(defaultGitTimeout(['push'])).toBe(300_000);
    process.env.MCA_GIT_TIMEOUT_MS = 'garbage';
    expect(defaultGitTimeout(['status'])).toBe(GIT_TIMEOUTS_MS.local);
  });
});
