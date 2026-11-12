/**
 * SEC-3 (TER-722 / A4) regression tests — command injection in clone-repo.
 *
 * The tool used to interpolate agent-controlled `owner`/`repo`/`branch`/
 * `destination` into a shell string for `execSync`. These tests MORDER on both
 * defenses: (1) boundary validation rejects shell/option metacharacters, and
 * (2) the argv builder keeps every value a single literal element (no shell can
 * split or evaluate it). A structural check pins that the shell sink is gone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gitStatus } from '../../src/tools/git-status';
import { GitPathError } from '../../src/lib/git-local';
import {
  buildAuthConfig,
  buildCloneArgs,
  buildCloneArgv,
  cloneRepo,
  validateCloneInput,
} from '../../src/tools/clone-repo';

/** A non-empty, non-git directory: clone-repo must refuse it before resolving the token. */
function occupy(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notes.txt'), 'user data\n');
}

describe('validateCloneInput (A4 boundary)', () => {
  const injections = [
    '$(id)',
    '`id`',
    'main; touch /tmp/pwned',
    'a && rm -rf /',
    'x | cat',
    'a b', // space
    '../../etc',
    '-oProxyCommand=evil', // leading dash → git option injection
    '', // empty
  ];

  it('rejects an injected owner', () => {
    for (const bad of injections) {
      expect(() => validateCloneInput(bad, 'safe-repo')).toThrow(/Invalid owner/);
    }
  });

  it('rejects an injected repo', () => {
    for (const bad of injections) {
      expect(() => validateCloneInput('safe-owner', bad)).toThrow(/Invalid repo/);
    }
  });

  it('rejects an injected branch', () => {
    // '../../etc' is a valid ref charset (contains '/') so drop it from branch set;
    // everything else must be rejected.
    for (const bad of injections.filter((b) => b !== '../../etc')) {
      expect(() => validateCloneInput('safe-owner', 'safe-repo', bad)).toThrow(/Invalid branch/);
    }
  });

  it('accepts legitimate identifiers', () => {
    expect(() => validateCloneInput('acme-corp', 'widgets-api')).not.toThrow();
    expect(() => validateCloneInput('Org_1', 'my.repo-2')).not.toThrow();
    expect(() => validateCloneInput('o', 'r', 'feature/new-thing')).not.toThrow();
    expect(() => validateCloneInput('o', 'r', 'v1.2.3')).not.toThrow();
    expect(() => validateCloneInput('o', 'r', undefined)).not.toThrow();
  });
});

describe('buildCloneArgs (A4 argv form)', () => {
  it('builds argv without a branch, ending options with --', () => {
    expect(buildCloneArgs('https://host/o/r.git', '/workspace/r')).toEqual([
      'clone',
      '--',
      'https://host/o/r.git',
      '/workspace/r',
    ]);
  });

  it('builds argv with a branch as a single =-joined option', () => {
    expect(buildCloneArgs('https://host/o/r.git', '/workspace/r', 'dev')).toEqual([
      'clone',
      '--branch=dev',
      '--',
      'https://host/o/r.git',
      '/workspace/r',
    ]);
  });

  it('keeps a metacharacter-laden destination as ONE literal element (no shell split)', () => {
    const evil = '/workspace/r"; rm -rf / #';
    const args = buildCloneArgs('https://host/o/r.git', evil);
    // The whole malicious string is the final single argument — a shell never sees it.
    expect(args[args.length - 1]).toBe(evil);
    expect(args).toHaveLength(4);
  });
});

describe('clone-repo handler wires the boundary validation', () => {
  it('rejects an injected owner before touching the network or a shell', async () => {
    // Validation runs before resolveUserToken/spawnSync, so no mocks are needed.
    await expect(cloneRepo.handler({ owner: '$(id)', repo: 'safe' }, {} as never)).rejects.toThrow(
      /Invalid owner/,
    );
  });
});

describe('clone-repo has no shell sink (structural)', () => {
  it('has no execSync call/import and runs git through the argv-form runGit', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/tools/clone-repo.ts'), 'utf-8');
    expect(src).not.toMatch(/execSync\s*\(/); // no shell call (mentions in comments are fine)
    expect(src).not.toMatch(/import[^;]*\bexecSync\b/); // not even imported
    expect(src).not.toMatch(/\bexec\s*\(/);
    expect(src).toMatch(/runGit\s*\(/);
  });
});

describe('clone-repo default destination follows the process workspace (LOW audit fix)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'mca-clone-default-ws-'));
    process.env.MCA_WORKSPACE_PATH = workspace;
  });

  afterEach(() => {
    delete process.env.MCA_WORKSPACE_PATH;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it('defaults the destination to <workspace>/<owner>/<repo> when MCA_WORKSPACE_PATH points elsewhere', async () => {
    // Pre-create the default with a non-git file in it so the handler refuses
    // it with the resolved default in the message — reachable before token
    // resolution, so no network and no shell are needed.
    const expectedDefault = join(workspace, 'safe-owner', 'my-repo');
    occupy(expectedDefault);

    await expect(
      cloneRepo.handler({ owner: 'safe-owner', repo: 'my-repo' }, {} as never),
    ).rejects.toThrow(`[GIT_DESTINATION_OCCUPIED] ${expectedDefault} already exists and is not a git clone.`);
  });

  it('no longer promises an absolute /workspace default in the tool description', () => {
    const params = cloneRepo.parameters as unknown as {
      properties: { destination?: { description?: string } };
    };
    expect(params.properties.destination?.description).toBe(
      'Local path where the repo will be cloned (default: <workspace>/<owner>/<repo>, or an existing <workspace>/<repo> clone of the same repo)',
    );
  });
});

describe('clone-repo destination is sandboxed to the workspace (MEDIUM audit fix, 2026-10-01)', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'mca-clone-sandbox-ws-'));
    process.env.MCA_WORKSPACE_PATH = workspace;
  });

  afterEach(() => {
    delete process.env.MCA_WORKSPACE_PATH;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  // All of these must be rejected BEFORE the token is resolved — the handler
  // validates the destination first, so no network/shell is ever reached.
  it('rejects an absolute destination outside the workspace (/etc/evil)', async () => {
    await expect(
      cloneRepo.handler(
        { owner: 'safe-owner', repo: 'safe-repo', destination: '/etc/evil' },
        {} as never,
      ),
    ).rejects.toThrow(GitPathError);
  });

  it('rejects an absolute destination outside the workspace (/opt/teros)', async () => {
    await expect(
      cloneRepo.handler(
        { owner: 'safe-owner', repo: 'safe-repo', destination: '/opt/teros/pwned' },
        {} as never,
      ),
    ).rejects.toThrow(GitPathError);
  });

  it('rejects a relative destination that escapes via parent traversal (../../outside)', async () => {
    await expect(
      cloneRepo.handler(
        { owner: 'safe-owner', repo: 'safe-repo', destination: '../../outside' },
        {} as never,
      ),
    ).rejects.toThrow(GitPathError);
  });

  it('rejects a prefix-sibling of the workspace (/workspace-evil)', async () => {
    // The workspace here is a mkdtemp dir; craft a sibling that shares its prefix
    // but is NOT inside it (e.g. <tmp>/mca-clone-sandbox-ws-XXXX-evil).
    const sibling = `${workspace}-evil`;
    await expect(
      cloneRepo.handler(
        { owner: 'safe-owner', repo: 'safe-repo', destination: sibling },
        {} as never,
      ),
    ).rejects.toThrow(GitPathError);
  });

  it('accepts a relative destination and resolves it INSIDE the workspace', async () => {
    // A valid relative destination resolves inside the workspace — the handler
    // then inspects it. Pre-occupy the resolved path so the refusal fires with
    // the workspace-anchored path in the message (reachable before token
    // resolution → no network, no shell).
    const resolved = join(workspace, 'repos', 'safe-repo');
    occupy(resolved);

    await expect(
      cloneRepo.handler(
        { owner: 'safe-owner', repo: 'safe-repo', destination: 'repos/safe-repo' },
        {} as never,
      ),
    ).rejects.toThrow(`[GIT_DESTINATION_OCCUPIED] ${resolved} already exists`);
  });

  it('accepts an absolute destination inside the workspace', async () => {
    // Same technique: absolute path inside the workspace is legitimate.
    const resolved = join(workspace, 'safe-repo');
    occupy(resolved);

    await expect(
      cloneRepo.handler(
        { owner: 'safe-owner', repo: 'safe-repo', destination: resolved },
        {} as never,
      ),
    ).rejects.toThrow(`[GIT_DESTINATION_OCCUPIED] ${resolved} already exists`);
  });

  it('the error is classified GIT_INVALID_PATH (parity with resolveRepoPath)', async () => {
    let caught: unknown;
    try {
      await cloneRepo.handler(
        { owner: 'safe-owner', repo: 'safe-repo', destination: '/etc/evil' },
        {} as never,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitPathError);
    expect((caught as GitPathError).code).toBe('GIT_INVALID_PATH');
    expect((caught as Error).message).toMatch(/outside the workspace/);
  });
});

describe('clone-repo never embeds the user token in the clone URL (CRITICAL audit fix, 2026-10-01)', () => {
  const TOKEN = 'gho_FAKE1234567890abcdef';

  it('buildAuthConfig returns the ephemeral http.extraheader pair', () => {
    const flags = buildAuthConfig(TOKEN);
    expect(flags).toHaveLength(2);
    expect(flags[0]).toBe('-c');
    expect(flags[1]).toMatch(/^http\.extraheader=AUTHORIZATION: basic /);
    // The credential is base64(x-access-token:<token>) — decodable, but never
    // the raw token and never part of any URL.
    expect(flags[1]).not.toContain(TOKEN);
    expect(flags[1]).not.toContain('x-access-token');
    const b64 = flags[1].slice('http.extraheader=AUTHORIZATION: basic '.length);
    expect(Buffer.from(b64, 'base64').toString('utf-8')).toBe(`x-access-token:${TOKEN}`);
  });

  it('buildCloneArgv keeps the URL clean and injects the extraheader flags', () => {
    const argv = buildCloneArgv(TOKEN, 'https://github.com/foo/bar.git', '/workspace/bar', 'dev');
    // No argv element contains the raw token or the legacy userinfo pattern.
    for (const el of argv) {
      expect(el).not.toContain(TOKEN);
      expect(el).not.toContain('x-access-token:');
    }
    // The URL element is the clean one.
    expect(argv).toContain('https://github.com/foo/bar.git');
    // The ephemeral credential flags are present, before `clone`.
    expect(argv).toEqual(['-c', expect.stringMatching(/^http\.extraheader=/), 'clone', '--branch=dev', '--', 'https://github.com/foo/bar.git', '/workspace/bar']);
  });

  it('the handler source never builds an x-access-token URL (structural regression guard)', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/tools/clone-repo.ts'), 'utf-8');
    // The only legitimate x-access-token mention is inside the base64 payload
    // of buildAuthConfig — the URL construction must stay clean.
    expect(src).not.toMatch(/`https:\/\/x-access-token:\$\{token\}@/);
    expect(src).not.toMatch(/https:\/\/x-access-token:\$\{token\}@github\.com/);
    expect(src).toMatch(/http\.extraheader/);
  });
});

describe('clone-repo end-to-end: .git/config stays credential-free (CRITICAL audit fix, 2026-10-01)', () => {
  let workspace: string;
  let originPath: string;
  let clonePath: string;

  beforeEach(() => {
    // A local "remote" stands in for github.com — no network, no real token.
    workspace = mkdtempSync(join(tmpdir(), 'mca-clone-e2e-ws-'));
    process.env.MCA_WORKSPACE_PATH = workspace;
    originPath = join(workspace, 'origin-repo');
    clonePath = join(workspace, 'cloned-repo');
    mkdirSync(originPath);
    run(['init', '-q', '-b', 'main'], originPath);
    run(['config', 'user.email', 'test@example.com'], originPath);
    run(['config', 'user.name', 'Test'], originPath);
    write('hello\n', originPath, 'README.md');
    run(['add', 'README.md'], originPath);
    run(['commit', '-q', '-m', 'init'], originPath);
  });

  afterEach(() => {
    delete process.env.MCA_WORKSPACE_PATH;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  // Small helpers — argv-form, no shell.
  function run(args: string[], cwd: string) {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  function write(content: string, cwd: string, file: string) {
    writeFileSync(join(cwd, file), content);
  }

  it('clones with the extraheader pattern and leaves .git/config clean', async () => {
    // Simulate the handler's credential injection against the file:// remote:
    // exactly the argv the handler now builds (clean URL + -c extraheader).
    const token = 'gho_FAKE1234567890abcdef';
    const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    const clone = spawnSync(
      'git',
      [
        '-c', `http.extraheader=${authHeader}`,
        'clone',
        '--',
        originPath,
        clonePath,
      ],
      { encoding: 'utf-8' },
    );
    expect(clone.status).toBe(0);

    // THE regression assertion: the persisted remote URL must be clean.
    const config = readFileSync(join(clonePath, '.git', 'config'), 'utf-8');
    expect(config).not.toContain('x-access-token:');
    expect(config).not.toContain(token);
    expect(config).not.toContain(authHeader);
    expect(config).toContain('url = ' + originPath);
  });

  it('git-status reports sanitisedRemotes when a legacy contaminated remote exists', async () => {
    // Simulate a legacy repo: cloned with the OLD pattern (token in URL).
    const token = 'gho_FAKE1234567890abcdef';
    const legacyClone = spawnSync('git', ['clone', '--', `file://${originPath}`, clonePath], {
      encoding: 'utf-8',
    });
    expect(legacyClone.status).toBe(0);
    // Reproduce the legacy contamination exactly as the audit evidence shows.
    run(['remote', 'set-url', 'origin', `https://x-access-token:${token}@github.com/foo/bar.git`], clonePath);
    const before = readFileSync(join(clonePath, '.git', 'config'), 'utf-8');
    expect(before).toContain(`https://x-access-token:${token}@github.com/foo/bar.git`);

    // First git-status touch must sanitise it and report it.
    const r = (await gitStatus.handler({ repoPath: clonePath }, {} as never)) as Record<string, any>;
    expect(r.sanitisedRemotes).toEqual([
      { name: 'origin', cleanUrl: 'https://github.com/foo/bar.git' },
    ]);

    // And the file on disk must now be clean.
    const after = readFileSync(join(clonePath, '.git', 'config'), 'utf-8');
    expect(after).not.toContain('x-access-token:');
    expect(after).not.toContain(token);
    expect(after).toContain('url = https://github.com/foo/bar.git');
  });
});
