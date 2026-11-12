import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runGit } from '../../src/lib/git-local';
import { classifyGitError, throwClassifiedGitError } from '../../src/tools/_git-error';

// bug-git-github: "no permission to edit workflows" — GitHub refuses pushes
// touching .github/workflows/ without the App's Workflows permission, and the
// error came back as GIT_UNKNOWN; a 403 came back as GIT_NETWORK_ERROR.

const err = (stderr: string) => ({ code: 1, stdout: '', stderr });

// Shape of GitHub's answer (remote rejected line + failed to push).
const WORKFLOW_REFUSAL = [
  'To https://github.com/acme/api.git',
  " ! [remote rejected] main -> main (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)",
  "error: failed to push some refs to 'https://github.com/acme/api.git'",
].join('\n');

describe('push permission errors are classified', () => {
  it('workflow refusal (GitHub App) → GIT_WORKFLOW_PERMISSION naming the file and the way out', () => {
    const c = classifyGitError(err(WORKFLOW_REFUSAL));
    expect(c.code).toBe('GIT_WORKFLOW_PERMISSION');
    expect(c.message).toContain('`.github/workflows/ci.yml`');
    expect(c.message).toContain('Workflows');
    expect(c.message).toMatch(/has not accepted the "Workflows" permission yet/);
    expect(c.action.description).toMatch(/accept it once/);
    expect(c.action.description).toContain('Never reset');
  });

  it('workflow refusal (OAuth app / PAT wording) → GIT_WORKFLOW_PERMISSION', () => {
    const c = classifyGitError(
      err(" ! [remote rejected] f -> f (refusing to allow an OAuth App to create or update workflow `.github/workflows/x.yml` without `workflow` scope)"),
    );
    expect(c.code).toBe('GIT_WORKFLOW_PERMISSION');
  });

  it('HTTP 403 / "Permission to … denied" → GIT_PERMISSION_DENIED (was GIT_NETWORK_ERROR)', () => {
    const c = classifyGitError(
      err("remote: Permission to acme/api.git denied to octocat.\nfatal: unable to access 'https://github.com/acme/api.git/': The requested URL returned error: 403"),
    );
    expect(c.code).toBe('GIT_PERMISSION_DENIED');
    expect(c.action.description).toMatch(/installed/);
  });

  it('a 403 on push is about write access, on clone/fetch/pull about read access', () => {
    const stderr = "fatal: unable to access 'https://github.com/acme/api.git/': The requested URL returned error: 403";
    expect(classifyGitError({ ...err(stderr), command: 'push' }).message).toContain('write access');
    for (const command of ['clone', 'fetch', 'pull']) {
      const c = classifyGitError({ ...err(stderr), command });
      expect(c.code).toBe('GIT_PERMISSION_DENIED');
      expect(c.message).toContain('read access');
      expect(c.action.description).not.toMatch(/push rights/);
    }
  });

  it('HTTP 401 → GIT_AUTH_FAILED', () => {
    expect(
      classifyGitError(err("fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 401")).code,
    ).toBe('GIT_AUTH_FAILED');
  });

  it('"Repository not found" → GIT_REPO_NOT_ACCESSIBLE', () => {
    expect(
      classifyGitError(err("remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found")).code,
    ).toBe('GIT_REPO_NOT_ACCESSIBLE');
  });

  it('plain non-fast-forward is still GIT_PUSH_REJECTED', () => {
    expect(
      classifyGitError(err(" ! [rejected] main -> main (non-fast-forward)\nhint: Updates were rejected because the tip of your current branch is behind")).code,
    ).toBe('GIT_PUSH_REJECTED');
  });
});

describe('git-push end to end against a remote that refuses workflow changes', () => {
  let dir: string;
  const git = (args: string[], cwd?: string) => {
    const r = spawnSync('git', cwd ? ['-C', cwd, ...args] : args, { encoding: 'utf-8', env: { ...process.env } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mca-push-wf-'));
    process.env.MCA_WORKSPACE_PATH = dir;
    const bare = join(dir, 'remote.git');
    git(['init', '-q', '--bare', '-b', 'main', bare]);
    // Behave like GitHub without the Workflows permission.
    writeFileSync(
      join(bare, 'hooks', 'pre-receive'),
      [
        '#!/bin/sh',
        'while read old new ref; do',
        '  if git diff --name-only "$old" "$new" 2>/dev/null | grep -q "^.github/workflows/" || git ls-tree -r --name-only "$new" | grep -q "^.github/workflows/"; then',
        '    echo "refusing to allow a GitHub App to create or update workflow \\`.github/workflows/ci.yml\\` without \\`workflows\\` permission" >&2',
        '    exit 1',
        '  fi',
        'done',
      ].join('\n'),
      { mode: 0o755 },
    );

    const work = join(dir, 'acme', 'api');
    mkdirSync(work, { recursive: true });
    git(['init', '-q', '-b', 'main', work]);
    git(['config', 'user.email', 't@example.com'], work);
    git(['config', 'user.name', 'T'], work);
    git(['remote', 'add', 'origin', bare], work);
    mkdirSync(join(work, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(work, '.github', 'workflows', 'ci.yml'), 'on: push\n');
    git(['add', '.'], work);
    git(['commit', '-q', '-m', 'ci'], work);
  });

  afterEach(() => {
    delete process.env.MCA_WORKSPACE_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  // git-push itself refuses non-github.com remotes (token-exfiltration
  // guard), so the push runs through runGit — the same call git-push makes —
  // and the real git stderr ("remote: refusing…", "[remote rejected]") is
  // classified and formatted exactly as git-push would throw it.
  it('real git stderr classifies as GIT_WORKFLOW_PERMISSION, explained in the message the agent sees', async () => {
    const r = await runGit(join(dir, 'acme', 'api'), ['push', '-u', 'origin', 'main']);
    expect(r.code).not.toBe(0);
    let message = '';
    try {
      throwClassifiedGitError(r);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toStartWith('[GIT_WORKFLOW_PERMISSION] GitHub refused the push because it creates or changes `.github/workflows/ci.yml`');
    expect(message).toContain('\nWhat to do: Tell the user: Teros now asks for the "Workflows" permission');
    expect(message).toContain('git stderr:');
  });
});
