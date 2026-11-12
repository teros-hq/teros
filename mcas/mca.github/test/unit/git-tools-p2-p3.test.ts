import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  gitBisect,
  gitBlame,
  gitCherryPick,
  gitConfig,
  gitFetch,
  gitMerge,
  gitPull,
  gitPush,
  gitRebase,
  gitRemote,
  gitReset,
  gitStash,
  gitTag,
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
  workspace = mkdtempSync(join(tmpdir(), 'mca-git-p2p3-'));
  process.env.MCA_WORKSPACE_PATH = workspace;
  repoPath = join(workspace, 'sample');
  execSync(`mkdir -p ${repoPath}`);
  execSync(`git -C ${repoPath} init -q -b main`);
  execSync(`git -C ${repoPath} config user.email "test@example.com"`);
  execSync(`git -C ${repoPath} config user.name "Test User"`);
  writeFileSync(join(repoPath, 'README.md'), '# Sample\nLine 2\nLine 3\n');
  execSync(`git -C ${repoPath} add README.md && git -C ${repoPath} commit -q -m "init"`);
});

/**
 * Setup helper: creates two divergent branches that conflict on the same line
 * of README.md. Returns the names of both branches.
 *
 *   main:    "# Sample\nLine 2\nLine 3\n"   (initial)
 *   feat-a:  changes line 2 to "Line 2 — A"
 *   feat-b:  changes line 2 to "Line 2 — B"
 *
 * After this, a `git merge feat-a feat-b` or rebase/cherry-pick from feat-b
 * onto feat-a conflicts on line 2.
 */
function setupConflictingBranches() {
  execSync(`git -C ${repoPath} checkout -q -b feat-a`);
  writeFileSync(join(repoPath, 'README.md'), '# Sample\nLine 2 — A\nLine 3\n');
  execSync(`git -C ${repoPath} commit -q -am "A: change line 2"`);

  execSync(`git -C ${repoPath} checkout -q main`);
  execSync(`git -C ${repoPath} checkout -q -b feat-b`);
  writeFileSync(join(repoPath, 'README.md'), '# Sample\nLine 2 — B\nLine 3\n');
  execSync(`git -C ${repoPath} commit -q -am "B: change line 2"`);
  return { branchA: 'feat-a', branchB: 'feat-b' };
}

afterEach(() => {
  delete process.env.MCA_WORKSPACE_PATH;
  rmSync(workspace, { recursive: true, force: true });
});

// ============================================================================
// git-stash
// ============================================================================

describe('git-stash', () => {
  it('lists empty when no stash entries', async () => {
    const r = (await gitStash.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(r.entries).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('push + list + pop cycle', async () => {
    writeFileSync(join(repoPath, 'README.md'), '# Sample v2\n');
    const push = (await gitStash.handler(
      { repoPath, action: 'push', message: 'wip' },
      ctx as never,
    )) as Record<string, any>;
    expect(push.action).toBe('push');

    const list = (await gitStash.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(list.total).toBe(1);
    expect(list.entries[0].description).toContain('wip');

    await gitStash.handler({ repoPath, action: 'pop' }, ctx as never);
    const after = execSync(`git -C ${repoPath} stash list`, { encoding: 'utf-8' }).trim();
    expect(after).toBe('');
  });
});

// ============================================================================
// git-merge
// ============================================================================

describe('git-merge', () => {
  it('fast-forward merges another branch', async () => {
    execSync(`git -C ${repoPath} checkout -q -b feature`);
    writeFileSync(join(repoPath, 'feature.ts'), 'export const x = 1\n');
    execSync(`git -C ${repoPath} add feature.ts && git -C ${repoPath} commit -q -m "feat: x"`);
    execSync(`git -C ${repoPath} checkout -q main`);
    const r = (await gitMerge.handler(
      { repoPath, target: 'feature' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.branch).toBe('main');
    expect(r.target).toBe('feature');
  });
});

// ============================================================================
// git-reset
// ============================================================================

describe('git-reset', () => {
  it('mixed reset unstages changes but keeps working tree', async () => {
    writeFileSync(join(repoPath, 'staged.txt'), 'x');
    execSync(`git -C ${repoPath} add staged.txt`);
    await gitReset.handler({ repoPath, mode: 'mixed' }, ctx as never);
    const status = execSync(`git -C ${repoPath} status --porcelain`, { encoding: 'utf-8' });
    expect(status).toContain('?? staged.txt'); // file still on disk, no longer staged
  });

  it('soft reset moves HEAD but keeps everything else', async () => {
    writeFileSync(join(repoPath, 'a.txt'), 'a');
    execSync(`git -C ${repoPath} add a.txt && git -C ${repoPath} commit -q -m "extra"`);
    await gitReset.handler({ repoPath, mode: 'soft', target: 'HEAD~1' }, ctx as never);
    const status = execSync(`git -C ${repoPath} status --porcelain`, { encoding: 'utf-8' });
    expect(status).toContain('A  a.txt'); // staged
  });
});

// ============================================================================
// git-config
// ============================================================================

describe('git-config', () => {
  it('rejects keys not in the whitelist', async () => {
    await expect(
      gitConfig.handler({ repoPath, action: 'set', key: 'credential.helper', value: '/tmp/x' }, ctx as never),
    ).rejects.toThrow(/not whitelisted/);
  });

  it('set + get for user.email', async () => {
    await gitConfig.handler(
      { repoPath, action: 'set', key: 'user.email', value: 'bot@teros.ai' },
      ctx as never,
    );
    const r = (await gitConfig.handler(
      { repoPath, action: 'get', key: 'user.email' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.value).toBe('bot@teros.ai');
  });

  it('list returns only whitelisted keys', async () => {
    const r = (await gitConfig.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(r.entries['user.email']).toBeDefined();
    // Internal keys like core.repositoryformatversion are filtered out.
    expect(r.entries['core.repositoryformatversion']).toBeUndefined();
  });
});

// ============================================================================
// git-tag
// ============================================================================

describe('git-tag', () => {
  it('create + list + delete', async () => {
    await gitTag.handler(
      { repoPath, action: 'create', name: 'v0.1.0', message: 'release' },
      ctx as never,
    );
    const list = (await gitTag.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(list.tags).toContain('v0.1.0');
    await gitTag.handler({ repoPath, action: 'delete', name: 'v0.1.0' }, ctx as never);
    const after = (await gitTag.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(after.tags).not.toContain('v0.1.0');
  });
});

// ============================================================================
// git-remote
// ============================================================================

describe('git-remote', () => {
  it('add + list + remove', async () => {
    await gitRemote.handler(
      { repoPath, action: 'add', name: 'upstream', url: 'https://github.com/x/y.git' },
      ctx as never,
    );
    const list = (await gitRemote.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(list.remotes.find((r: any) => r.name === 'upstream')).toBeDefined();
    await gitRemote.handler({ repoPath, action: 'remove', name: 'upstream' }, ctx as never);
    const after = (await gitRemote.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(after.remotes.find((r: any) => r.name === 'upstream')).toBeUndefined();
  });

  // ==========================================================================
  // URL policy (audit 2026-10-01, MEDIUM): add/set-url only accept clean
  // github.com HTTPS URLs.
  // ==========================================================================

  it('accepts a clean github.com HTTPS URL (with and without .git)', async () => {
    await gitRemote.handler(
      { repoPath, action: 'add', name: 'origin', url: 'https://github.com/foo/bar.git' },
      ctx as never,
    );
    await gitRemote.handler(
      { repoPath, action: 'set-url', name: 'origin', url: 'https://github.com/foo/bar' },
      ctx as never,
    );
    const cfg = execSync(`git -C ${repoPath} remote get-url origin`, {
      encoding: 'utf-8',
    }).trim();
    expect(cfg).toBe('https://github.com/foo/bar');
  });

  it('rejects set-url with a token embedded in the URL (credential persistence)', async () => {
    await gitRemote.handler(
      { repoPath, action: 'add', name: 'origin', url: 'https://github.com/foo/bar.git' },
      ctx as never,
    );
    await expect(
      gitRemote.handler(
        {
          repoPath,
          action: 'set-url',
          name: 'origin',
          url: 'https://x-access-token:gho_FAKE1234567890@github.com/foo/bar.git',
        },
        ctx as never,
      ),
    ).rejects.toThrow(/GIT_INVALID_INPUT/);
    // Nothing was written to .git/config.
    const cfg = execSync(`git -C ${repoPath} remote get-url origin`, {
      encoding: 'utf-8',
    }).trim();
    expect(cfg).toBe('https://github.com/foo/bar.git');
  });

  it('rejects add with a foreign host (token exfiltration via remotes)', async () => {
    await expect(
      gitRemote.handler(
        { repoPath, action: 'add', name: 'evil', url: 'https://attacker.com/foo/bar.git' },
        ctx as never,
      ),
    ).rejects.toThrow(/GIT_INVALID_INPUT/);
    const list = (await gitRemote.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(list.remotes.find((r: any) => r.name === 'evil')).toBeUndefined();
  });

  it('rejects non-https schemes (ssh://, git://)', async () => {
    await expect(
      gitRemote.handler(
        { repoPath, action: 'add', name: 'origin', url: 'ssh://git@github.com/foo/bar.git' },
        ctx as never,
      ),
    ).rejects.toThrow(/GIT_INVALID_INPUT/);
    await expect(
      gitRemote.handler(
        { repoPath, action: 'add', name: 'origin', url: 'git://github.com/foo/bar.git' },
        ctx as never,
      ),
    ).rejects.toThrow(/GIT_INVALID_INPUT/);
  });

  it('rejects lookalike hosts and ports', async () => {
    for (const url of [
      'https://github.com.evil.com/foo/bar.git',
      'https://attacker.com/github.com/foo/bar.git',
      'https://github.com:8443/foo/bar.git',
      'https://github.com/foo/bar.git?x=1',
    ]) {
      await expect(
        gitRemote.handler({ repoPath, action: 'add', name: 'origin', url }, ctx as never),
      ).rejects.toThrow(/GIT_INVALID_INPUT/);
    }
  });

  it('rejects remote names outside the safe charset', async () => {
    for (const name of ['-evil', 'evil name', 'evil;rm', 'https://attacker.com/x.git']) {
      await expect(
        gitRemote.handler(
          { repoPath, action: 'add', name, url: 'https://github.com/foo/bar.git' },
          ctx as never,
        ),
      ).rejects.toThrow(/GIT_INVALID_INPUT/);
    }
  });
});

// ============================================================================
// git-push / git-fetch / git-pull — token-exfiltration guard (audit 2026-10-01)
// The extraheader credential is attached to every URL git contacts; a remote
// pointing outside github.com would receive the user's token.
// ============================================================================

describe('git-push — remote guard', () => {
  it('rejects a push to a foreign-host remote before token resolution', async () => {
    execSync(`git -C ${repoPath} remote add evil https://attacker.com/foo/bar.git`);
    await expect(
      gitPush.handler({ repoPath, remote: 'evil', branch: 'main' }, ctx as never),
    ).rejects.toThrow(/GIT_REMOTE_NOT_GITHUB/);
  });

  it('rejects a push whose remote is an inline URL (remote bypass)', async () => {
    await expect(
      gitPush.handler(
        { repoPath, remote: 'https://attacker.com/foo/bar.git', branch: 'main' },
        ctx as never,
      ),
    ).rejects.toThrow(/GIT_INVALID_INPUT/);
  });

  it('rejects a push whose remote has an explicit foreign push URL', async () => {
    execSync(`git -C ${repoPath} remote add origin https://github.com/foo/bar.git`);
    execSync(`git -C ${repoPath} remote set-url --push origin https://attacker.com/foo/bar.git`);
    await expect(
      gitPush.handler({ repoPath, remote: 'origin', branch: 'main' }, ctx as never),
    ).rejects.toThrow(/GIT_REMOTE_NOT_GITHUB/);
  });

  it('passes the guard for a clean github.com remote (fails later on network, not on guard)', async () => {
    execSync(`git -C ${repoPath} remote add origin https://github.com/foo/bar.git`);
    const err = await gitPush
      .handler({ repoPath, remote: 'origin', branch: 'main' }, ctx as never)
      .then(() => 'ok')
      .catch((e) => (e as Error).message);
    // The guard passed — the failure (if any) is git's own network/refspec
    // error, never the guard codes.
    expect(err).not.toMatch(/GIT_REMOTE_NOT_GITHUB|GIT_INVALID_INPUT.*remote name/);
  });
});

describe('git-fetch — remote guard', () => {
  it('rejects a fetch from a foreign-host remote before token resolution', async () => {
    execSync(`git -C ${repoPath} remote add evil https://attacker.com/foo/bar.git`);
    await expect(gitFetch.handler({ repoPath, remote: 'evil' }, ctx as never)).rejects.toThrow(
      /GIT_REMOTE_NOT_GITHUB/,
    );
  });

  it('rejects a fetch whose remote is an inline URL (remote bypass)', async () => {
    await expect(
      gitFetch.handler({ repoPath, remote: 'https://attacker.com/foo/bar.git' }, ctx as never),
    ).rejects.toThrow(/GIT_INVALID_INPUT/);
  });

  it('passes the guard for a clean github.com remote', async () => {
    execSync(`git -C ${repoPath} remote add origin https://github.com/foo/bar.git`);
    const err = await gitFetch
      .handler({ repoPath, remote: 'origin' }, ctx as never)
      .then(() => 'ok')
      .catch((e) => (e as Error).message);
    expect(err).not.toMatch(/GIT_REMOTE_NOT_GITHUB|GIT_INVALID_INPUT.*remote name/);
  });
});

describe('git-pull — remote guard', () => {
  it('rejects a pull with an explicit foreign-host remote before token resolution', async () => {
    execSync(`git -C ${repoPath} remote add evil https://attacker.com/foo/bar.git`);
    await expect(gitPull.handler({ repoPath, remote: 'evil' }, ctx as never)).rejects.toThrow(
      /GIT_REMOTE_NOT_GITHUB/,
    );
  });

  it('rejects a pull whose branch upstream tracks a foreign-host remote', async () => {
    execSync(`git -C ${repoPath} remote add evil https://attacker.com/foo/bar.git`);
    // Write the tracking config directly — `--set-upstream-to` would require
    // the remote-tracking ref to exist (needs a fetch).
    execSync(`git -C ${repoPath} config branch.main.remote evil`);
    execSync(`git -C ${repoPath} config branch.main.merge refs/heads/main`);
    await expect(gitPull.handler({ repoPath }, ctx as never)).rejects.toThrow(
      /GIT_REMOTE_NOT_GITHUB/,
    );
  });

  it('rejects a pull whose remote is an inline URL (remote bypass)', async () => {
    await expect(
      gitPull.handler({ repoPath, remote: 'https://attacker.com/foo/bar.git' }, ctx as never),
    ).rejects.toThrow(/GIT_INVALID_INPUT/);
  });
});

// ============================================================================
// git-blame
// ============================================================================

describe('git-blame', () => {
  it('returns per-line attribution', async () => {
    const r = (await gitBlame.handler(
      { repoPath, path: 'README.md' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.total).toBe(3);
    expect(r.lines[0].author).toBe('Test User');
    expect(r.lines[0].content).toBe('# Sample');
    expect(r.lines[0].sha).toMatch(/^[a-f0-9]{40}$/);
  });
});

// ============================================================================
// Conflict paths — verify the classifier returns GIT_CONFLICT on rebase and
// cherry-pick, not just on merge.
// ============================================================================

describe('git-merge — conflict path', () => {
  it('throws GIT_CONFLICT when merging diverging branches with same-line edits', async () => {
    setupConflictingBranches();
    execSync(`git -C ${repoPath} checkout -q feat-a`);
    await expect(
      gitMerge.handler({ repoPath, target: 'feat-b' }, ctx as never),
    ).rejects.toThrow(/GIT_CONFLICT/);
  });
});

describe('git-rebase — conflict path', () => {
  it('throws GIT_CONFLICT when rebasing onto a diverging branch', async () => {
    setupConflictingBranches();
    execSync(`git -C ${repoPath} checkout -q feat-b`);
    await expect(
      gitRebase.handler({ repoPath, onto: 'feat-a' }, ctx as never),
    ).rejects.toThrow(/GIT_CONFLICT/);
  });

  it('mode: abort cleans up an in-progress rebase', async () => {
    setupConflictingBranches();
    execSync(`git -C ${repoPath} checkout -q feat-b`);
    // Drive it into a conflict, then abort.
    await gitRebase.handler({ repoPath, onto: 'feat-a' }, ctx as never).catch(() => {});
    const r = (await gitRebase.handler({ repoPath, mode: 'abort' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(r.mode).toBe('abort');
    // After abort the tree should be clean and on feat-b again.
    const status = execSync(`git -C ${repoPath} status --porcelain`, { encoding: 'utf-8' });
    expect(status.trim()).toBe('');
  });
});

describe('git-cherry-pick — conflict path', () => {
  it('throws GIT_CONFLICT when cherry-picking a commit that conflicts', async () => {
    setupConflictingBranches();
    execSync(`git -C ${repoPath} checkout -q feat-a`);
    const bSha = execSync(`git -C ${repoPath} rev-parse feat-b`, { encoding: 'utf-8' }).trim();
    await expect(
      gitCherryPick.handler({ repoPath, commits: [bSha] }, ctx as never),
    ).rejects.toThrow(/GIT_CONFLICT/);
  });

  it('mode: abort cancels an in-progress cherry-pick', async () => {
    setupConflictingBranches();
    execSync(`git -C ${repoPath} checkout -q feat-a`);
    const bSha = execSync(`git -C ${repoPath} rev-parse feat-b`, { encoding: 'utf-8' }).trim();
    await gitCherryPick.handler({ repoPath, commits: [bSha] }, ctx as never).catch(() => {});
    const r = (await gitCherryPick.handler({ repoPath, mode: 'abort' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(r.mode).toBe('abort');
    const status = execSync(`git -C ${repoPath} status --porcelain`, { encoding: 'utf-8' });
    expect(status.trim()).toBe('');
  });
});

// ============================================================================
// git-fetch — sync without merge (replaces gh pr checkout)
// ============================================================================

describe('git-fetch', () => {
  it('throws a classifiable error when no remote is configured', async () => {
    // No remote → git emits "No remote configured" or similar; we only assert
    // the tool surfaces a clean error (not crash) without an upstream.
    const result = await gitFetch
      .handler({ repoPath }, ctx as never)
      .then(() => 'ok')
      .catch((e) => (e as Error).message);
    expect(result).not.toBe('ok');
  });
});

// ============================================================================
// git-option injection hardening (audit 2026-10-01, MEDIUM)
// ============================================================================

describe('git-option injection hardening (audit 2026-10-01)', () => {
  // A ref that starts with '-' would be parsed by git as an option of the
  // subcommand (e.g. `--upload-pack=evil` on merge/cherry-pick). Every tool
  // must reject it with GIT_INVALID_REF before git ever sees it.
  const ATTACK_REF = '--upload-pack=evil';

  it('git-merge rejects a dash-leading target', async () => {
    await expect(gitMerge.handler({ repoPath, target: ATTACK_REF }, ctx as never)).rejects.toThrow(
      /GIT_INVALID_REF/,
    );
  });

  it('git-rebase rejects a dash-leading onto', async () => {
    await expect(
      gitRebase.handler({ repoPath, onto: ATTACK_REF }, ctx as never),
    ).rejects.toThrow(/GIT_INVALID_REF/);
  });

  it('git-cherry-pick rejects a dash-leading commit', async () => {
    await expect(
      gitCherryPick.handler({ repoPath, commits: [ATTACK_REF] }, ctx as never),
    ).rejects.toThrow(/GIT_INVALID_REF/);
  });

  it('git-cherry-pick rejects a dash-leading commit among valid ones', async () => {
    await expect(
      gitCherryPick.handler({ repoPath, commits: ['main', ATTACK_REF] }, ctx as never),
    ).rejects.toThrow(/GIT_INVALID_REF/);
  });

  it('git-reset rejects a dash-leading target', async () => {
    await expect(
      gitReset.handler({ repoPath, mode: 'hard', target: ATTACK_REF }, ctx as never),
    ).rejects.toThrow(/GIT_INVALID_REF/);
  });

  it('git-tag rejects a dash-leading tag name on create', async () => {
    await expect(
      gitTag.handler({ repoPath, action: 'create', name: ATTACK_REF }, ctx as never),
    ).rejects.toThrow(/GIT_INVALID_REF/);
  });

  it('git-tag rejects a dash-leading tag name on delete', async () => {
    await expect(
      gitTag.handler({ repoPath, action: 'delete', name: ATTACK_REF }, ctx as never),
    ).rejects.toThrow(/GIT_INVALID_REF/);
  });

  it('git-tag rejects a dash-leading ref on create', async () => {
    await expect(
      gitTag.handler(
        { repoPath, action: 'create', name: 'v1', ref: ATTACK_REF },
        ctx as never,
      ),
    ).rejects.toThrow(/GIT_INVALID_REF/);
  });

  it('git-bisect rejects a dash-leading bad rev on start', async () => {
    await expect(
      gitBisect.handler({ repoPath, action: 'start', bad: ATTACK_REF }, ctx as never),
    ).rejects.toThrow(/GIT_INVALID_REF/);
  });

  it('git-bisect rejects a dash-leading good rev on start', async () => {
    await expect(
      gitBisect.handler(
        { repoPath, action: 'start', bad: 'HEAD', good: ATTACK_REF },
        ctx as never,
      ),
    ).rejects.toThrow(/GIT_INVALID_REF/);
  });

  it('git-bisect rejects a dash-leading ref on good/bad/skip', async () => {
    await expect(
      gitBisect.handler({ repoPath, action: 'good', ref: ATTACK_REF }, ctx as never),
    ).rejects.toThrow(/GIT_INVALID_REF/);
  });

  it('git-merge still merges a normal branch after the hardening (regression)', async () => {
    execSync(`git -C ${repoPath} checkout -q -b feature`);
    writeFileSync(join(repoPath, 'feature.ts'), 'export const x = 1\n');
    execSync(`git -C ${repoPath} add feature.ts && git -C ${repoPath} commit -q -m "feat: x"`);
    execSync(`git -C ${repoPath} checkout -q main`);
    const r = (await gitMerge.handler(
      { repoPath, target: 'feature' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.branch).toBe('main');
    expect(r.target).toBe('feature');
  });

  it('git-rebase still rebases onto a normal branch after the hardening (regression)', async () => {
    execSync(`git -C ${repoPath} checkout -q -b feature`);
    writeFileSync(join(repoPath, 'feature.ts'), 'export const x = 1\n');
    execSync(`git -C ${repoPath} add feature.ts && git -C ${repoPath} commit -q -m "feat: x"`);
    execSync(`git -C ${repoPath} checkout -q main`);
    execSync(`git -C ${repoPath} checkout -q -b topic main~0`);
    const r = (await gitRebase.handler(
      { repoPath, onto: 'feature' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.mode).toBe('start');
    expect(r.onto).toBe('feature');
  });

  it('git-cherry-pick still picks a normal SHA after the hardening (regression)', async () => {
    execSync(`git -C ${repoPath} checkout -q -b feature`);
    writeFileSync(join(repoPath, 'feature.ts'), 'export const x = 1\n');
    execSync(`git -C ${repoPath} add feature.ts && git -C ${repoPath} commit -q -m "feat: x"`);
    const sha = execSync(`git -C ${repoPath} rev-parse feature`, { encoding: 'utf-8' }).trim();
    execSync(`git -C ${repoPath} checkout -q main`);
    const base = execSync(`git -C ${repoPath} rev-parse main`, { encoding: 'utf-8' }).trim();
    const r = (await gitCherryPick.handler(
      { repoPath, commits: [sha] },
      ctx as never,
    )) as Record<string, any>;
    const picked = execSync(`git -C ${repoPath} log -1 --format=%P%n%s%n%T ${r.head}`, { encoding: 'utf-8' }).trim().split('\n');
    const featureTree = execSync(`git -C ${repoPath} rev-parse ${sha}^{tree}`, { encoding: 'utf-8' }).trim();
    expect(picked).toEqual([base, 'feat: x', featureTree]);
  });

  it('git-tag create/list/delete still work after the hardening (regression)', async () => {
    await gitTag.handler(
      { repoPath, action: 'create', name: 'v0.1.0', message: 'release' },
      ctx as never,
    );
    const list = (await gitTag.handler(
      { repoPath, action: 'list', pattern: 'v*' },
      ctx as never,
    )) as Record<string, any>;
    expect(list.tags).toContain('v0.1.0');
    await gitTag.handler({ repoPath, action: 'delete', name: 'v0.1.0' }, ctx as never);
    const after = (await gitTag.handler({ repoPath, action: 'list' }, ctx as never)) as Record<
      string,
      any
    >;
    expect(after.tags).not.toContain('v0.1.0');
  });

  it('git-bisect start/reset still work with normal revs after the hardening (regression)', async () => {
    execSync(`git -C ${repoPath} commit -q --allow-empty -m "second"`);
    const r = (await gitBisect.handler(
      { repoPath, action: 'start', bad: 'HEAD', good: 'HEAD~1' },
      ctx as never,
    )) as Record<string, any>;
    expect(r.action).toBe('start');
    await gitBisect.handler({ repoPath, action: 'reset' }, ctx as never);
  });
});
