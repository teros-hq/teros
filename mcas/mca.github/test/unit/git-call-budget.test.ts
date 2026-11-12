import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { GIT_CALL_BUDGET_MS, gitCallTimeLeftMs, withGitCallBudget } from '../../src/lib/git-call-budget';
import { runGit } from '../../src/lib/git-local';
import { REPO_LOCK_FILE } from '../../src/lib/repo-lock';
import { classifyGitError } from '../../src/tools/_git-error';
import { gitAdd } from '../../src/tools/git-add';

let binDir: string;
let fakeEnv: NodeJS.ProcessEnv;
let workspace: string;
let repoPath: string;

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'mca-budget-git-'));
  writeFileSync(join(binDir, 'git'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  fakeEnv = { PATH: `${binDir}:/usr/bin:/bin` };
  workspace = mkdtempSync(join(tmpdir(), 'mca-budget-ws-'));
  process.env.MCA_WORKSPACE_PATH = workspace;
  repoPath = join(workspace, 'repo');
  execSync(`git init -q -b main ${repoPath}`);
});

afterEach(() => {
  delete process.env.MCA_GIT_CALL_BUDGET_MS;
  delete process.env.MCA_WORKSPACE_PATH;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe('git call budget', () => {
  it('defaults below the backend 120 s tool-call timeout and is scoped to the call', async () => {
    expect(GIT_CALL_BUDGET_MS).toBeLessThan(120_000);
    expect(gitCallTimeLeftMs()).toBeUndefined();
    await withGitCallBudget(async () => {
      expect(gitCallTimeLeftMs()).toBeGreaterThan(GIT_CALL_BUDGET_MS - 1_000);
      await withGitCallBudget(async () => {
        expect(gitCallTimeLeftMs()).toBeLessThanOrEqual(GIT_CALL_BUDGET_MS);
      });
    });
    expect(gitCallTimeLeftMs()).toBeUndefined();
  });

  it('caps each git command at what is left of the call, minus the kill grace', async () => {
    process.env.MCA_GIT_CALL_BUDGET_MS = '6500';
    const started = Date.now();
    const r = await withGitCallBudget(() => runGit(tmpdir(), ['push'], { env: fakeEnv }));
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(r.error?.code).toBe('ETIMEDOUT');
    expect(r.timeoutMs).toBeLessThanOrEqual(1_500);
    expect(r.budgetCapped).toBe(true);
    const c = classifyGitError(r);
    expect(c.code).toBe('GIT_TIMEOUT');
    expect(c.message).toMatch(/time budget/);
  });

  it('a command started after the budget ran out fails at once without running git', async () => {
    process.env.MCA_GIT_CALL_BUDGET_MS = '1000';
    const r = await withGitCallBudget(async () => {
      const started = Date.now();
      const result = await runGit(tmpdir(), ['push'], { env: fakeEnv });
      expect(Date.now() - started).toBeLessThan(500);
      return result;
    });
    expect(r.error?.code).toBe('ETIMEDOUT');
    expect(r.budgetCapped).toBe(true);
  });

  it('commands outside a budgeted call keep their own timeout', async () => {
    const r = await runGit(tmpdir(), ['push'], { env: fakeEnv, timeout: 200 });
    expect(r.timeoutMs).toBe(200);
    expect(r.budgetCapped).toBeUndefined();
  });

  it('a locked tool stops waiting for the repo lock when its call budget runs out', async () => {
    process.env.MCA_GIT_CALL_BUDGET_MS = '1000';
    const lockPath = join(repoPath, '.git', REPO_LOCK_FILE);
    writeFileSync(
      lockPath,
      JSON.stringify({ host: 'mca-github-other', pid: 1, tool: 'git-push', startedAt: new Date().toISOString(), token: 'other' }),
    );
    const t = (Date.now() + 60_000) / 1000;
    utimesSync(lockPath, t, t);
    const started = Date.now();
    await expect(gitAdd.handler({ repoPath, paths: ['.'] }, {} as never)).rejects.toThrow(/GIT_LOCKED/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
