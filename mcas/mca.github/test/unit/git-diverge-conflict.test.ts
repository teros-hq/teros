import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { classifyGitError } from '../../src/tools/_git-error';
import { runGit } from '../../src/lib/git-local';
import { divergence, pullFlags } from '../../src/tools/git-pull';

const ctx = {
  getUserSecrets: async () => ({ USER_ACCESS_TOKEN: 'ghu_diverge_test_token_123456', USER_LOGIN: 'octo' }),
  getSystemSecrets: async () => ({}),
} as never;

describe('diverged branches (006)', () => {
  const DEFAULT_PULL =
    "hint: You have divergent branches and need to specify how to reconcile them.\nhint: You can do so by running one of the following commands sometime before\nfatal: Need to specify how to reconcile divergent branches.";
  const FF_ONLY = "hint: Diverging branches can't be fast-forwarded, you need to either:\nfatal: Not possible to fast-forward, aborting.";

  it.each([DEFAULT_PULL, FF_ONLY])('classifies %# as GIT_DIVERGED with the rebase step', (stderr) => {
    const c = classifyGitError({ code: 128, stdout: '', stderr, command: 'pull' });
    expect(c.code).toBe('GIT_DIVERGED');
    expect(c.action.description).toContain('rebase: true');
  });

  it('a rejected push points to git-pull with rebase: true', () => {
    const c = classifyGitError({
      code: 1,
      stdout: '',
      stderr: " ! [rejected]        main -> main (non-fast-forward)\nhint: Updates were rejected because the tip of your current branch is behind",
      command: 'push',
    });
    expect(c.code).toBe('GIT_PUSH_REJECTED');
    expect(c.action.description).toContain('rebase: true');
  });
});

describe('conflict advice follows the operation and names the files (008)', () => {
  it('during a rebase: continue the rebase, never git-commit', () => {
    const c = classifyGitError({
      code: 1,
      stdout: '',
      stderr:
        'Auto-merging README.md\nCONFLICT (content): Merge conflict in README.md\nerror: could not apply 1a2b3c4... feat\nhint: Resolve all conflicts manually, mark them as resolved with\nhint: "git add/rm <conflicted_files>", then run "git rebase --continue".',
      command: 'rebase',
    });
    expect(c.code).toBe('GIT_CONFLICT');
    expect(c.message).toContain('README.md');
    expect(c.action.description).toContain('mode: "continue"');
    expect(c.action.description).not.toContain('git-commit');
  });

  it('during a merge: names the files and finishes with git-commit', () => {
    const c = classifyGitError({
      code: 1,
      stdout: 'Auto-merging src/a.ts\nCONFLICT (content): Merge conflict in src/a.ts\nCONFLICT (modify/delete): docs/b.md deleted in HEAD and modified in origin/main.\nAutomatic merge failed; fix conflicts and then commit the result.',
      stderr: '',
      command: 'merge',
    });
    expect(c.code).toBe('GIT_CONFLICT');
    expect(c.message).toContain('src/a.ts');
    expect(c.message).toContain('docs/b.md');
    expect(c.action.description).toContain('git-commit');
  });
});

describe('git-pull does not depend on the git config (006)', () => {
  let root: string;
  let clone: string;
  const env = { ...process.env };

  function git(cwd: string, args: string[]) {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', env: process.env }).trim();
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mca-diverge-'));
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'T';
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@example.com';
    process.env.MCA_WORKSPACE_PATH = root;
    const bare = join(root, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.file://${bare}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/acme/api.git';
    const seed = join(root, 'seed');
    execFileSync('git', ['clone', '-q', 'https://github.com/acme/api.git', seed], { env: process.env });
    writeFileSync(join(seed, 'README.md'), 'one\n');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-qm', 'init']);
    git(seed, ['push', '-q', 'origin', 'main']);
    clone = join(root, 'acme', 'api');
    execFileSync('git', ['clone', '-q', 'https://github.com/acme/api.git', clone], { env: process.env });
    writeFileSync(join(clone, 'LOCAL.md'), 'local\n');
    git(clone, ['add', '.']);
    git(clone, ['commit', '-qm', 'local']);
    writeFileSync(join(seed, 'REMOTE.md'), 'remote\n');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-qm', 'remote']);
    git(seed, ['push', '-q', 'origin', 'main']);
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
    rmSync(root, { recursive: true, force: true });
  });

  it('a default pull is --ff-only, so diverged branches stop with GIT_DIVERGED', async () => {
    expect(pullFlags({})).toEqual(['--ff-only']);
    const r = await runGit(clone, ['pull', ...pullFlags({})]);
    expect(r.code).not.toBe(0);
    expect(classifyGitError(r).code).toBe('GIT_DIVERGED');
  });

  it('the divergence is counted for the message', async () => {
    await runGit(clone, ['fetch', '-q']);
    expect(await divergence(clone)).toEqual({ local: 1, remote: 1 });
  });

  it('rebase: true reconciles them, and the strategy is always explicit', async () => {
    expect(pullFlags({ rebase: true })).toEqual(['--rebase']);
    expect(pullFlags({ ff: 'no' })).toEqual(['--no-rebase', '--no-ff']);
    const r = await runGit(clone, ['pull', ...pullFlags({ rebase: true })]);
    expect(r.code).toBe(0);
    expect(git(clone, ['log', '--format=%s', '-3'])).toBe('local\nremote\ninit');
  });
});
