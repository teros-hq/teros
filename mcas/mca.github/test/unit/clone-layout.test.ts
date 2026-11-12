import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { GitPathError, githubSlugFromUrl, resolveRepoPath } from '../../src/lib/git-local';
import { buildCloneArgs, cloneRepo } from '../../src/tools/clone-repo';

// bug-git-github: 11 broken clones of one repo; same-named repos of different
// owners collided at <workspace>/<repo>; an existing destination was refused
// and partial clones from a timeout were never cleaned up.
//
// The handler hardcodes https://github.com/<owner>/<repo>.git; git's
// `url.<base>.insteadOf` (via GIT_CONFIG_* env, inherited by runGit) points it
// at a local bare repo — real clones, no network.

const TOKEN = 'gho_FAKEtoken1234567890abcd';
const context = {
  getUserSecrets: async () => ({ USER_ACCESS_TOKEN: TOKEN }),
  getSystemSecrets: async () => ({}),
} as never;

let workspace: string;
let originDir: string;

function git(args: string[], cwd?: string) {
  // Explicit env: Bun's spawnSync does not pick up process.env changes made at runtime.
  const r = spawnSync('git', cwd ? ['-C', cwd, ...args] : args, { encoding: 'utf-8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A bare origin with one commit, served as https://github.com/<owner>/<repo>.git. */
function serveOrigin(
  owner: string,
  repo: string,
  target = join(originDir, `${owner}-${repo}.git`),
  create = true,
) {
  if (create && !existsSync(target)) {
    const work = mkdtempSync(join(originDir, 'work-'));
    git(['init', '-q', '-b', 'main', work]);
    git(['config', 'user.email', 't@example.com'], work);
    git(['config', 'user.name', 'T'], work);
    writeFileSync(join(work, 'README.md'), `# ${owner}/${repo}\n`);
    git(['add', 'README.md'], work);
    git(['commit', '-q', '-m', 'init'], work);
    git(['clone', '-q', '--bare', work, target]);
  }
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  process.env[`GIT_CONFIG_KEY_${n}`] = `url.file://${target}.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${n}`] = `https://github.com/${owner}/${repo}.git`;
  process.env.GIT_CONFIG_COUNT = String(n + 1);
}

/** A clone of owner/repo made the old way, at `dir`. */
function legacyClone(owner: string, repo: string, dir: string) {
  serveOrigin(owner, repo);
  git(['clone', '-q', `https://github.com/${owner}/${repo}.git`, dir]);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mca-clone-layout-ws-'));
  originDir = mkdtempSync(join(tmpdir(), 'mca-clone-layout-origin-'));
  process.env.MCA_WORKSPACE_PATH = workspace;
});

afterEach(() => {
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  for (let i = 0; i < n; i++) {
    delete process.env[`GIT_CONFIG_KEY_${i}`];
    delete process.env[`GIT_CONFIG_VALUE_${i}`];
  }
  delete process.env.GIT_CONFIG_COUNT;
  delete process.env.MCA_WORKSPACE_PATH;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(originDir, { recursive: true, force: true });
});

type CloneResult = {
  path: string;
  branch: string;
  sha: string;
  reused?: boolean;
  note?: string;
  replacedBrokenClone?: { movedTo: string; reason: string };
};
const clone = (args: Record<string, unknown>) => cloneRepo.handler(args, context) as Promise<CloneResult>;

describe('clone-repo layout: <workspace>/<owner>/<repo>', () => {
  it('clones same-named repos of different owners side by side', async () => {
    serveOrigin('acme', 'api');
    serveOrigin('other', 'api');
    const a = await clone({ owner: 'acme', repo: 'api' });
    const b = await clone({ owner: 'other', repo: 'api' });
    expect(a.path).toBe(join(workspace, 'acme', 'api'));
    expect(b.path).toBe(join(workspace, 'other', 'api'));
    expect(readFileSync(join(a.path, 'README.md'), 'utf-8')).toBe('# acme/api\n');
    expect(readFileSync(join(b.path, 'README.md'), 'utf-8')).toBe('# other/api\n');
    // The token never lands on disk.
    expect(readFileSync(join(a.path, '.git', 'config'), 'utf-8')).not.toContain(TOKEN);
  });

  it('reuses a legacy <workspace>/<repo> clone of the same repo instead of cloning it twice', async () => {
    legacyClone('acme', 'api', join(workspace, 'api'));
    const r = await clone({ owner: 'acme', repo: 'api' });
    expect(r.path).toBe(join(workspace, 'api'));
    expect(r.reused).toBe(true);
    expect(existsSync(join(workspace, 'acme'))).toBe(false);
  });

  it('a legacy clone of a different owner does not block the clone', async () => {
    legacyClone('other', 'api', join(workspace, 'api'));
    serveOrigin('acme', 'api');
    const r = await clone({ owner: 'acme', repo: 'api' });
    expect(r.path).toBe(join(workspace, 'acme', 'api'));
    expect(r.reused).toBeUndefined();
  });

  it('refuses to nest a clone inside another clone (legacy repo named like the owner)', async () => {
    legacyClone('acme', 'acme', join(workspace, 'acme'));
    serveOrigin('acme', 'api');
    await expect(clone({ owner: 'acme', repo: 'api' })).rejects.toThrow(
      /\[GIT_DESTINATION_OCCUPIED\] .*would be inside the clone at/,
    );
  });

  it('shallow clones with depth', async () => {
    serveOrigin('acme', 'api');
    const r = await clone({ owner: 'acme', repo: 'api', depth: 1 });
    expect(git(['rev-parse', '--is-shallow-repository'], r.path)).toBe('true');
    await expect(clone({ owner: 'acme', repo: 'api', depth: 0 })).rejects.toThrow(/Invalid depth/);
    expect(buildCloneArgs('u', 'd', undefined, 5)).toEqual(['clone', '--depth=5', '--', 'u', 'd']);
  });
});

describe('clone-repo on an existing destination', () => {
  it('returns a working clone of the same repo as-is (idempotent, no checkout)', async () => {
    serveOrigin('acme', 'api');
    const first = await clone({ owner: 'acme', repo: 'api' });
    writeFileSync(join(first.path, 'wip.txt'), 'another agent is working here\n');
    const again = await clone({ owner: 'acme', repo: 'api', branch: 'dev' });
    expect(again.reused).toBe(true);
    expect(again.sha).toBe(first.sha);
    expect(again.note).toContain('use git-checkout for "dev"');
    expect(existsSync(join(first.path, 'wip.txt'))).toBe(true);
  });

  it('replaces a clone that died while fetching (HEAD unresolvable) and keeps it aside', async () => {
    serveOrigin('acme', 'api');
    const dest = join(workspace, 'acme', 'api');
    // What a killed `git clone` leaves: .git with the origin configured, no commits.
    git(['init', '-q', '-b', 'main', dest]);
    git(['remote', 'add', 'origin', 'https://github.com/acme/api.git'], dest);
    const r = await clone({ owner: 'acme', repo: 'api' });
    expect(r.path).toBe(dest);
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.replacedBrokenClone?.reason).toContain('HEAD does not resolve');
    expect(existsSync(r.replacedBrokenClone!.movedTo)).toBe(true); // moved aside, not deleted
  });

  it('replaces a clone that died while checking out (no index)', async () => {
    legacyClone('acme', 'api', join(workspace, 'acme', 'api'));
    rmSync(join(workspace, 'acme', 'api', '.git', 'index'));
    const r = await clone({ owner: 'acme', repo: 'api' });
    expect(r.replacedBrokenClone?.reason).toContain('no index');
    expect(existsSync(join(r.path, 'README.md'))).toBe(true);
  });

  it('keeps a clone of an empty repository (unborn HEAD is not corruption there)', async () => {
    const bare = join(originDir, 'empty.git');
    git(['init', '-q', '--bare', '-b', 'main', bare]);
    serveOrigin('acme', 'empty', bare);
    const first = await clone({ owner: 'acme', repo: 'empty' });
    const again = await clone({ owner: 'acme', repo: 'empty' });
    expect(again.reused).toBe(true);
    expect(again.path).toBe(first.path);
    expect(readdirSync(join(workspace, 'acme')).filter((e) => e.includes('corrupt'))).toEqual([]);
  });

  it('refuses a destination holding a different repository', async () => {
    legacyClone('other', 'thing', join(workspace, 'acme', 'api'));
    serveOrigin('acme', 'api');
    await expect(clone({ owner: 'acme', repo: 'api' })).rejects.toThrow(
      /\[GIT_DESTINATION_OCCUPIED\] .* already holds a different repository \(origin: https:\/\/github.com\/other\/thing.git\)/,
    );
  });

  it('clones into an existing empty directory', async () => {
    serveOrigin('acme', 'api');
    mkdirSync(join(workspace, 'acme', 'api'), { recursive: true });
    const r = await clone({ owner: 'acme', repo: 'api' });
    expect(existsSync(join(r.path, 'README.md'))).toBe(true);
  });
});

describe('clone-repo never leaves a partial clone behind', () => {
  it('a failed clone leaves nothing at the destination or in temp dirs', async () => {
    serveOrigin('acme', 'gone', join(originDir, 'missing.git'), false); // local path that does not exist
    await expect(clone({ owner: 'acme', repo: 'gone' })).rejects.toThrow(/^\[GIT_UNKNOWN\].*\nWhat to do:.*\ngit stderr: .*does not appear to be a git repository/s);
    expect(existsSync(join(workspace, 'acme', 'gone'))).toBe(false);
    expect(readdirSync(join(workspace, 'acme'))).toEqual([]);
  });

  it('sweeps temp dirs left by a clone that was killed', async () => {
    serveOrigin('acme', 'api');
    const leftover = join(workspace, 'acme', '.api.clone-deadbeef');
    mkdirSync(join(leftover, '.git'), { recursive: true });
    await clone({ owner: 'acme', repo: 'api' });
    expect(existsSync(leftover)).toBe(false);
    expect(readdirSync(join(workspace, 'acme'))).toEqual(['api']);
  });

  it('two agents cloning the same repo at once get one clone', async () => {
    serveOrigin('acme', 'api');
    const [a, b] = await Promise.all([clone({ owner: 'acme', repo: 'api' }), clone({ owner: 'acme', repo: 'api' })]);
    expect(a.path).toBe(b.path);
    expect([a.reused, b.reused].filter(Boolean)).toHaveLength(1);
    expect(readdirSync(join(workspace, 'acme'))).toEqual(['api']);
  });
});

describe('git-* tools find clones in both layouts', () => {
  it('owner + repo → <workspace>/<owner>/<repo> once it exists', async () => {
    serveOrigin('acme', 'api');
    await clone({ owner: 'acme', repo: 'api' });
    expect(resolveRepoPath({ owner: 'acme', repo: 'api' })).toBe(join(workspace, 'acme', 'api'));
  });

  it('owner + repo → the legacy clone of the same repo', () => {
    legacyClone('acme', 'api', join(workspace, 'api'));
    expect(resolveRepoPath({ owner: 'acme', repo: 'api' })).toBe(join(workspace, 'api'));
  });

  it('owner + repo → not a legacy clone of a different owner', () => {
    legacyClone('other', 'api', join(workspace, 'api'));
    expect(resolveRepoPath({ owner: 'acme', repo: 'api' })).toBe(join(workspace, 'acme', 'api'));
  });

  it('repo only → the single owner clone, and asks for owner when ambiguous', async () => {
    serveOrigin('acme', 'api');
    serveOrigin('other', 'api');
    await clone({ owner: 'acme', repo: 'api' });
    expect(resolveRepoPath({ repo: 'api' })).toBe(join(workspace, 'acme', 'api'));
    await clone({ owner: 'other', repo: 'api' });
    expect(() => resolveRepoPath({ repo: 'api' })).toThrow(GitPathError);
    expect(() => resolveRepoPath({ repo: 'api' })).toThrow(/acme\/api, other\/api|other\/api, acme\/api/);
  });

  it('repo only → a plain <workspace>/<repo> folder does not hide the owner clone', async () => {
    serveOrigin('acme', 'api');
    await clone({ owner: 'acme', repo: 'api' });
    mkdirSync(join(workspace, 'api'));
    expect(resolveRepoPath({ repo: 'api' })).toBe(join(workspace, 'acme', 'api'));
  });

  it('matches GitHub origins with legacy credentials, .git suffix, ssh form, any case', () => {
    expect(githubSlugFromUrl('https://x-access-token:ghs_abc@github.com/Acme/API.git')).toBe('acme/api');
    expect(githubSlugFromUrl('https://github.com/acme/api')).toBe('acme/api');
    expect(githubSlugFromUrl('git@github.com:acme/api.git')).toBe('acme/api');
    expect(githubSlugFromUrl('https://gitlab.com/acme/api.git')).toBeNull();
  });
});

describe('each agent works in its own clone (009)', () => {
  const asAgent = (agentId: string) =>
    ({ ...(context as object), execution: { agentId, userId: 'user_1', appId: 'app_gh' } }) as never;

  it('two agents on the same repo keep their own branch', async () => {
    serveOrigin('acme', 'api');
    const { gitCheckout } = await import('../../src/tools/git-checkout');
    const { gitStatus } = await import('../../src/tools/git-status');

    const a = (await cloneRepo.handler({ owner: 'acme', repo: 'api' }, asAgent('agent_a'))) as CloneResult;
    const b = (await cloneRepo.handler({ owner: 'acme', repo: 'api' }, asAgent('agent_b'))) as CloneResult;
    expect(a.path).not.toBe(b.path);

    await Promise.all([
      gitCheckout.handler({ owner: 'acme', repo: 'api', target: 'a-branch', create: true }, asAgent('agent_a')),
      gitCheckout.handler({ owner: 'acme', repo: 'api', target: 'b-branch', create: true }, asAgent('agent_b')),
    ]);

    const statusA = (await gitStatus.handler({ owner: 'acme', repo: 'api' }, asAgent('agent_a'))) as { branch: string };
    const statusB = (await gitStatus.handler({ owner: 'acme', repo: 'api' }, asAgent('agent_b'))) as { branch: string };
    expect(statusA.branch).toBe('a-branch');
    expect(statusB.branch).toBe('b-branch');
  });

  it("an agent's clone is never handed out as reused by another agent", async () => {
    serveOrigin('acme', 'api');
    await cloneRepo.handler({ owner: 'acme', repo: 'api' }, asAgent('agent_a'));
    const b = (await cloneRepo.handler({ owner: 'acme', repo: 'api' }, asAgent('agent_b'))) as CloneResult & { reused?: boolean };
    expect(b.reused).toBeUndefined();
  });

  it('an agent without its own clone is told to clone, not sent to the shared one', async () => {
    legacyClone('acme', 'api', join(workspace, 'acme', 'api'));
    const { gitStatus } = await import('../../src/tools/git-status');
    await expect(gitStatus.handler({ owner: 'acme', repo: 'api' }, asAgent('agent_c'))).rejects.toThrow(/clone-repo/);
  });
});
