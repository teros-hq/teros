import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { GIT_TIMEOUTS_MS, LOCK_RETRY_DELAYS_MS, isLockContention, runGit } from '../../src/lib/git-local';
import { REPO_LOCK_FILE, renewRepoLease, repoLockPath, withLockFile, withRepoLock } from '../../src/lib/repo-lock';
import { classifyGitError } from '../../src/tools/_git-error';
import { gitAdd } from '../../src/tools/git-add';
import { gitCommit } from '../../src/tools/git-commit';

// bug-git-github: agents of one workspace share one clone across several
// containers and nothing serialised their git writes.

let workspace: string;
let repoPath: string;
let lockPath: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mca-lock-ws-'));
  process.env.MCA_WORKSPACE_PATH = workspace;
  repoPath = join(workspace, 'repo');
  execSync(`git init -q -b main ${repoPath}`);
  execSync(`git -C ${repoPath} config user.email t@example.com`);
  execSync(`git -C ${repoPath} config user.name T`);
  writeFileSync(join(repoPath, 'README.md'), '# r\n');
  execSync(`git -C ${repoPath} add README.md && git -C ${repoPath} commit -q -m init`);
  lockPath = join(repoPath, '.git', REPO_LOCK_FILE);
});

afterEach(() => {
  delete process.env.MCA_WORKSPACE_PATH;
  delete process.env.MCA_GIT_LOCK_WAIT_MS;
  rmSync(workspace, { recursive: true, force: true });
});

/** A lock held by "another container": foreign holder, lease in the future. */
function foreignLock(leaseMs: number, tool = 'git-push') {
  writeFileSync(
    lockPath,
    JSON.stringify({ host: 'mca-github-other', pid: 1, tool, startedAt: new Date().toISOString(), token: 'other' }),
  );
  const t = (Date.now() + leaseMs) / 1000;
  utimesSync(lockPath, t, t);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withRepoLock', () => {
  it('lives in .git/ and is removed on release', async () => {
    expect(repoLockPath(repoPath)).toBe(lockPath);
    await withRepoLock(repoPath, 'git-commit', async () => {
      expect(existsSync(lockPath)).toBe(true);
      expect(JSON.parse(readFileSync(lockPath, 'utf-8')).tool).toBe('git-commit');
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('serialises two writers on the same repo', async () => {
    const events: string[] = [];
    const writer = (name: string) =>
      withRepoLock(repoPath, name, async () => {
        events.push(`${name}:start`);
        await sleep(150);
        events.push(`${name}:end`);
      });
    await Promise.all([writer('a'), writer('b')]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('waits for a holder in another container, then proceeds', async () => {
    foreignLock(60_000);
    setTimeout(() => rmSync(lockPath), 300);
    const started = Date.now();
    await withRepoLock(repoPath, 'git-commit', async () => {});
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('breaks a lock whose lease expired (holder crashed) without waiting', async () => {
    foreignLock(-5 * 60_000);
    const started = Date.now();
    let ran = false;
    await withRepoLock(repoPath, 'git-commit', async () => {
      ran = true;
    }, { waitMs: 10_000 });
    expect(ran).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('gives up with GIT_LOCKED naming the holder after waitMs', async () => {
    foreignLock(60_000, 'git-push');
    await expect(withRepoLock(repoPath, 'git-commit', async () => {}, { waitMs: 200 })).rejects.toThrow(
      /\[GIT_LOCKED\] Another agent is using this repository: `git-push`.*mca-github-other/,
    );
    expect(existsSync(lockPath)).toBe(true); // never removes a live foreign lock
  });

  it('does not delete a lock that is no longer its own', async () => {
    await withRepoLock(repoPath, 'git-commit', async () => {
      // Our lease was broken as stale and someone else took the lock.
      foreignLock(60_000);
    });
    expect(existsSync(lockPath)).toBe(true);
  });

  it('removes its half-made lock when writing the lease fails', async () => {
    const utimes = spyOn(fs, 'utimesSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });
    try {
      await expect(withRepoLock(repoPath, 'git-commit', async () => {})).rejects.toThrow(/EPERM/);
    } finally {
      utimes.mockRestore();
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  it('runs unlocked when the path has no .git directory', async () => {
    expect(repoLockPath(workspace)).toBeNull();
    expect(await withRepoLock(workspace, 'git-add', async () => 42)).toBe(42);
  });

  it('runGit renews the lease past the command budget while the lock is held', async () => {
    await withRepoLock(repoPath, 'git-push', async () => {
      await runGit(repoPath, ['-c', 'x.y=z', 'push', '--dry-run', 'nowhere']); // network budget
      expect(statSync(lockPath).mtimeMs).toBeGreaterThan(Date.now() + GIT_TIMEOUTS_MS.network);
    });
    renewRepoLease(repoPath, 1_000); // not held anymore → no-op, no throw
  });

  it('two locks held under one lease key (clones into one parent) keep their own leases', async () => {
    const a = join(workspace, '.a.teros-clone.lock');
    const b = join(workspace, '.b.teros-clone.lock');
    let releaseA = () => {};
    const aHeld = new Promise<void>((r) => {
      releaseA = r;
    });
    const first = withLockFile(a, workspace, 'clone-repo', () => aHeld, {}, () => 'busy');
    await withLockFile(b, workspace, 'clone-repo', async () => {
      renewRepoLease(workspace, 300_000);
      expect(statSync(a).mtimeMs).toBeGreaterThan(Date.now() + 200_000);
      releaseA();
      await first;
      expect(existsSync(a)).toBe(false);
      renewRepoLease(workspace, 400_000);
      expect(statSync(b).mtimeMs).toBeGreaterThan(Date.now() + 300_000);
    }, {}, () => 'busy');
    expect(existsSync(b)).toBe(false);
  });

  it('a shorter command (e.g. git-status during a push) never shortens the lease', async () => {
    await withRepoLock(repoPath, 'git-push', async () => {
      await runGit(repoPath, ['rev-parse', 'HEAD'], { timeout: 300_000 });
      const long = statSync(lockPath).mtimeMs;
      await runGit(repoPath, ['status']); // default local budget
      expect(statSync(lockPath).mtimeMs).toBeGreaterThanOrEqual(long);
    });
  });
});

describe('locked git tools', () => {
  it('a commit waits for another container holding the repo, instead of racing it', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'a\n');
    await gitAdd.handler({ repoPath, paths: ['a.txt'] }, {} as never);
    foreignLock(60_000);
    setTimeout(() => rmSync(lockPath), 300);
    const r = (await gitCommit.handler({ repoPath, message: 'add a' }, {} as never)) as { sha: string };
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('surfaces GIT_LOCKED when the holder does not finish in time', async () => {
    process.env.MCA_GIT_LOCK_WAIT_MS = '200';
    foreignLock(60_000, 'git-pull');
    await expect(gitAdd.handler({ repoPath, paths: ['.'] }, {} as never)).rejects.toThrow(/GIT_LOCKED.*git-pull/);
  });
});

// git run from bash/terminal does not take our lock — git's own lockfiles
// still collide, and git fails instead of waiting.
describe('runGit retries git lockfile contention', () => {
  const indexLock = () => join(repoPath, '.git', 'index.lock');

  it('succeeds once a transient index.lock goes away', async () => {
    writeFileSync(join(repoPath, 'b.txt'), 'b\n');
    writeFileSync(indexLock(), '');
    setTimeout(() => rmSync(indexLock()), 400);
    const r = await runGit(repoPath, ['add', 'b.txt']);
    expect(r.code).toBe(0);
  });

  it('reports a persistent lock as GIT_LOCKED with its path and age', async () => {
    writeFileSync(join(repoPath, 'c.txt'), 'c\n');
    writeFileSync(indexLock(), '');
    const old = (Date.now() - 20 * 60_000) / 1000;
    utimesSync(indexLock(), old, old);
    const started = Date.now();
    const r = await runGit(repoPath, ['add', 'c.txt']);
    const minimum = LOCK_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(minimum);
    expect(r.code).toBe(128);
    expect(r.lockAgeMs).toBeGreaterThan(19 * 60_000);
    const c = classifyGitError(r);
    expect(c.code).toBe('GIT_LOCKED');
    expect(c.message).toContain('index.lock');
    expect(c.message).toContain('20 min old');
    expect(c.action.description).toMatch(/left over.*delete/);
  }, 20_000);

  it('retries only lockfile contention, not ordinary failures or ref conflicts', () => {
    expect(isLockContention("fatal: Unable to create '/w/r/.git/index.lock': File exists.")).toBe(true);
    expect(isLockContention("error: cannot lock ref 'refs/heads/main': Unable to create '/w/r/.git/refs/heads/main.lock': File exists.")).toBe(true);
    expect(isLockContention('Another git process seems to be running in this repository')).toBe(true);
    expect(isLockContention("error: pathspec 'nope' did not match any file(s) known to git")).toBe(false);
    expect(isLockContention("error: cannot lock ref 'refs/heads/a/b': 'refs/heads/a' exists; cannot create 'refs/heads/a/b'")).toBe(false);
  });

  it('a lockfile git cannot create for another reason is not contention', () => {
    for (const reason of ['Permission denied', 'Read-only file system', 'No space left on device']) {
      const stderr = `fatal: Unable to create '/w/r/.git/index.lock': ${reason}`;
      expect(isLockContention(stderr)).toBe(false);
      expect(classifyGitError({ stdout: '', stderr, code: 128 }).code).not.toBe('GIT_LOCKED');
    }
  });
});
