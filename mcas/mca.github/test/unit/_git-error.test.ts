import { describe, expect, it } from 'bun:test';

import { classifyGitError, throwClassifiedGitError } from '../../src/tools/_git-error';

function err(code: number, stderr: string, stdout = '') {
  return { code, stderr, stdout };
}

describe('classifyGitError', () => {
  it('maps exit -1 with timeout/enoent stderr to GIT_TIMEOUT or GIT_NOT_INSTALLED', () => {
    // -1 + no further info → treated as timeout (defensive).
    expect(classifyGitError(err(-1, '')).code).toBe('GIT_TIMEOUT');
    expect(classifyGitError(err(-1, 'ENOENT git not found')).code).toBe('GIT_NOT_INSTALLED');
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

describe('throwClassifiedGitError', () => {
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
