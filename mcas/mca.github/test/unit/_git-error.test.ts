import { describe, expect, it } from 'bun:test';

import type { GitResult } from '../../src/lib/git-local';
import { classifyGitError, throwClassifiedGitError } from '../../src/tools/_git-error';

function err(code: number, stderr: string, stdout = '') {
  return { code, stderr, stdout };
}

describe('classifyGitError', () => {
  it('maps a bare exit -1 (no spawn error recorded) to GIT_TIMEOUT (legacy fallback)', () => {
    expect(classifyGitError(err(-1, '')).code).toBe('GIT_TIMEOUT');
  });

  it('maps "not a git repository" to GIT_NOT_A_REPO', () => {
    expect(classifyGitError(err(128, 'fatal: not a git repository')).code).toBe('GIT_NOT_A_REPO');
  });

  it('maps merge/rebase/cherry-pick conflict to GIT_CONFLICT', () => {
    expect(
      classifyGitError(err(1, 'CONFLICT (content): Merge conflict in src/a.ts')).code,
    ).toBe('GIT_CONFLICT');
  });

  it('maps "nothing to commit" to GIT_NO_CHANGES', () => {
    expect(classifyGitError(err(1, 'nothing to commit, working tree clean')).code).toBe(
      'GIT_NO_CHANGES',
    );
  });

  it('maps auth failed to GIT_AUTH_FAILED', () => {
    expect(classifyGitError(err(128, 'fatal: Authentication failed for ...')).code).toBe(
      'GIT_AUTH_FAILED',
    );
  });

  it('maps existing branch to GIT_BRANCH_EXISTS', () => {
    expect(
      classifyGitError(err(128, 'fatal: A branch named feature/x already exists')).code,
    ).toBe('GIT_BRANCH_EXISTS');
  });

  it('maps pathspec not match to GIT_REF_NOT_FOUND', () => {
    expect(classifyGitError(err(128, "error: pathspec 'feat/x' did not match any file(s)")).code).toBe(
      'GIT_REF_NOT_FOUND',
    );
  });

  it('maps "would be overwritten" to GIT_DIRTY_TREE', () => {
    expect(
      classifyGitError(err(1, 'error: Your local changes to the following files would be overwritten')).code,
    ).toBe('GIT_DIRTY_TREE');
  });

  it('maps non-fast-forward to GIT_PUSH_REJECTED', () => {
    expect(
      classifyGitError(err(1, 'error: failed to push some refs to ...\nhint: Updates were rejected because the tip of your current branch is behind\nhint: Updates were rejected because the remote contains work')).code,
    ).toBe('GIT_PUSH_REJECTED');
  });

  it('maps detached head to GIT_DETACHED_HEAD', () => {
    expect(classifyGitError(err(1, 'HEAD is detached')).code).toBe('GIT_DETACHED_HEAD');
  });

  it('maps network errors to GIT_NETWORK_ERROR', () => {
    expect(classifyGitError(err(128, 'fatal: unable to access ... Could not resolve host')).code).toBe(
      'GIT_NETWORK_ERROR',
    );
  });

  it('maps index.lock to GIT_LOCKED', () => {
    expect(classifyGitError(err(128, 'fatal: Unable to lock ref ... index.lock')).code).toBe(
      'GIT_LOCKED',
    );
  });

  it('falls back to GIT_UNKNOWN on unrecognised stderr', () => {
    const c = classifyGitError(err(2, 'totally unexpected text from git'));
    expect(c.code).toBe('GIT_UNKNOWN');
    expect(c.message).toContain('totally unexpected text');
  });

  it('action surfaces include type + description', () => {
    const c = classifyGitError(err(128, 'fatal: Authentication failed'));
    expect(c.action.type).toBe('user_action');
    expect(c.action.description.length).toBeGreaterThan(0);
  });
});

// bug-git-github: runGit used to drop spawnSync's `error`/`signal`, so every
// abnormal termination became GIT_TIMEOUT. Each failure shape now has its own
// code, keyed on the spawn error code (never its message: Bun and Node differ).
describe('classifyGitError — abnormal termination (bug-git-github)', () => {
  const abnormal = (extra: Partial<GitResult>): GitResult => ({
    code: -1,
    stdout: '',
    stderr: '',
    ...extra,
  });

  it('ETIMEDOUT → GIT_TIMEOUT naming the command and the budget', () => {
    const c = classifyGitError(
      abnormal({ error: { code: 'ETIMEDOUT', message: 'x' }, signal: 'SIGTERM', command: 'status', timeoutMs: 90_000 }),
    );
    expect(c.code).toBe('GIT_TIMEOUT');
    expect(c.message).toContain('git status');
    expect(c.message).toContain('90 s');
    expect(c.action.description).toMatch(/untracked|gitignore/);
  });

  it('a timed-out network op suggests a shallow/narrow transfer instead of a blind retry', () => {
    const c = classifyGitError(
      abnormal({ error: { code: 'ETIMEDOUT', message: 'x' }, command: 'clone', timeoutMs: 110_000, stderr: 'Receiving objects:  42%' }),
    );
    expect(c.code).toBe('GIT_TIMEOUT');
    expect(c.action.description).toContain('depth');
    expect(c.message).toContain('Receiving objects:  42%');
  });

  it('a network op cut by the call budget keeps the shallow/narrow transfer advice', () => {
    const c = classifyGitError(
      abnormal({ error: { code: 'ETIMEDOUT', message: 'x' }, command: 'clone', timeoutMs: 109_900, budgetCapped: true }),
    );
    expect(c.code).toBe('GIT_TIMEOUT');
    expect(c.message).toContain('110 s');
    expect(c.message).toContain('budget');
    expect(c.action.description).toContain('depth');
  });

  it('a command the call budget left no time for says it never started', () => {
    const c = classifyGitError(
      abnormal({ error: { code: 'ETIMEDOUT', message: 'x' }, command: 'push', timeoutMs: 0, budgetCapped: true }),
    );
    expect(c.code).toBe('GIT_TIMEOUT');
    expect(c.message).toMatch(/not started/);
    expect(c.action.description).toMatch(/other agents/);
  });

  it('ENOENT → GIT_NOT_INSTALLED (was GIT_TIMEOUT)', () => {
    expect(classifyGitError(abnormal({ error: { code: 'ENOENT', message: 'spawn git ENOENT' } })).code).toBe(
      'GIT_NOT_INSTALLED',
    );
  });

  it('ENOBUFS → GIT_OUTPUT_TOO_LARGE (was GIT_TIMEOUT)', () => {
    const c = classifyGitError(
      abnormal({ error: { code: 'ENOBUFS', message: 'over limit' }, signal: 'SIGTERM', command: 'log' }),
    );
    expect(c.code).toBe('GIT_OUTPUT_TOO_LARGE');
    expect(c.action.description).toContain('maxCount');
  });

  it('EAGAIN → GIT_SPAWN_FAILED with a resource hint (was GIT_TIMEOUT)', () => {
    const c = classifyGitError(abnormal({ error: { code: 'EAGAIN', message: 'spawn EAGAIN' }, command: 'add' }));
    expect(c.code).toBe('GIT_SPAWN_FAILED');
    expect(c.message).toContain('EAGAIN');
    expect(c.action.description).toMatch(/processes|memory/);
  });

  it('killed by a signal with no spawn error → GIT_KILLED (OOM killer, container stop)', () => {
    const c = classifyGitError(abnormal({ signal: 'SIGKILL', command: 'clone' }));
    expect(c.code).toBe('GIT_KILLED');
    expect(c.message).toContain('SIGKILL');
    expect(c.action.description).toMatch(/memory/);
  });
});

describe('throwClassifiedGitError', () => {
  it('puts the action and git stderr in the message: the SDK sends the agent only error.message', () => {
    try {
      throwClassifiedGitError(err(128, "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"));
      expect.unreachable();
    } catch (e) {
      const lines = (e as Error).message.split('\n');
      expect(lines[0]).toBe('[GIT_NETWORK_ERROR] Could not reach the remote.');
      expect(lines[1]).toBe('What to do: Check network and retry.');
      expect(lines[2]).toContain('git stderr: fatal: unable to access');
    }
  });

  it('throws with [CODE] prefix and attaches the classified fields', () => {
    try {
      throwClassifiedGitError(err(128, 'fatal: not a git repository'));
      expect.unreachable();
    } catch (e) {
      const error = e as Error & { code?: string; action?: unknown; exitCode?: number };
      expect(error.message).toContain('[GIT_NOT_A_REPO]');
      expect(error.code).toBe('GIT_NOT_A_REPO');
      expect(error.exitCode).toBe(128);
      expect(error.action).toBeDefined();
    }
  });
});
