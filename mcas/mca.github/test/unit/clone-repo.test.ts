/**
 * SEC-3 (TER-722 / A4) regression tests — command injection in clone-repo.
 *
 * The tool used to interpolate agent-controlled `owner`/`repo`/`branch`/
 * `destination` into a shell string for `execSync`. These tests MORDER on both
 * defenses: (1) boundary validation rejects shell/option metacharacters, and
 * (2) the argv builder keeps every value a single literal element (no shell can
 * split or evaluate it). A structural check pins that the shell sink is gone.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildCloneArgs, cloneRepo, validateCloneInput } from '../../src/tools/clone-repo';

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
    expect(() => validateCloneInput('teros-hq', 'teros-private')).not.toThrow();
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
  it('has no execSync call/import and uses spawnSync + runGit', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/tools/clone-repo.ts'), 'utf-8');
    expect(src).not.toMatch(/execSync\s*\(/); // no shell call (mentions in comments are fine)
    expect(src).not.toMatch(/import[^;]*\bexecSync\b/); // not even imported
    expect(src).toMatch(/spawnSync\s*\(/);
    expect(src).toMatch(/runGit\s*\(/);
  });
});
