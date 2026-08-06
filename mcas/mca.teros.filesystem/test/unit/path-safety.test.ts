/**
 * Path safety regression tests.
 *
 * These cover the exact bug classes that hit the official MCP filesystem server
 * in 2025 (CVE-2025-53109 symlink→RCE, CVE-2025-53110 prefix bypass). Every
 * test here maps to a real historical failure mode.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { PathGuard } from '../../src/lib/path-safety';

const BASE = join(tmpdir(), `fs-v2-safety-${Date.now()}`);
const ALLOWED = join(BASE, 'allow');
const ALLOWED_ADJACENT = `${ALLOWED}_adjacent`; // CVE-2025-53110 candidate
const OUTSIDE = join(BASE, 'outside');

beforeEach(() => {
  mkdirSync(ALLOWED, { recursive: true });
  mkdirSync(ALLOWED_ADJACENT, { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(ALLOWED, 'ok.txt'), 'ok');
  writeFileSync(join(ALLOWED_ADJACENT, 'sneak.txt'), 'sneak');
  writeFileSync(join(OUTSIDE, 'secret.txt'), 'secret');
});

afterEach(() => {
  if (existsSync(BASE)) rmSync(BASE, { recursive: true, force: true });
});

describe('PathGuard — containment', () => {
  it('allows paths inside the allowed root', () => {
    const guard = new PathGuard({ roots: [ALLOWED] });
    expect(() => guard.resolve(join(ALLOWED, 'ok.txt'))).not.toThrow();
  });

  it('rejects relative traversal outside the jail', () => {
    const guard = new PathGuard({ roots: [ALLOWED] });
    expect(() => guard.resolve(join(ALLOWED, '..', 'outside', 'secret.txt'))).toThrow(
      /outside allowed roots/,
    );
  });

  it('rejects absolute paths outside the jail', () => {
    const guard = new PathGuard({ roots: [ALLOWED] });
    expect(() => guard.resolve(join(OUTSIDE, 'secret.txt'))).toThrow(/outside allowed roots/);
  });

  it('CVE-2025-53110 regression — refuses sibling directory that shares the prefix', () => {
    // Naive startsWith(root) would accept /tmp/.../allow_adjacent/sneak.txt
    // because it starts with /tmp/.../allow. Correct impl uses startsWith(root + sep).
    const guard = new PathGuard({ roots: [ALLOWED] });
    expect(() => guard.resolve(join(ALLOWED_ADJACENT, 'sneak.txt'))).toThrow(
      /outside allowed roots/,
    );
  });

  it('the exact root itself is allowed', () => {
    const guard = new PathGuard({ roots: [ALLOWED] });
    expect(() => guard.resolve(ALLOWED)).not.toThrow();
  });
});

describe('PathGuard — symlink handling (CVE-2025-53109)', () => {
  it('fails-closed on reads when target resolves outside', () => {
    const linkPath = join(ALLOWED, 'bad-link');
    const target = join(OUTSIDE, 'secret.txt');
    symlinkSync(target, linkPath);
    const guard = new PathGuard({ roots: [ALLOWED] });
    // The link is inside allow but its realpath is outside — must reject.
    expect(() => guard.resolve(linkPath)).toThrow(/outside allowed roots/);
  });

  it('for writes to non-existent path, validates the parent realpath (not a faked ancestor)', () => {
    const guard = new PathGuard({ roots: [ALLOWED] });
    const newFile = join(ALLOWED, 'subdir', 'fresh.txt');
    mkdirSync(join(ALLOWED, 'subdir'));
    // Must succeed: parent exists inside allowed root, target does not yet
    expect(() => guard.resolve(newFile, { forWrite: true })).not.toThrow();
  });

  it('for writes with bogus parent, rejects', () => {
    const guard = new PathGuard({ roots: [ALLOWED] });
    const bogus = join(OUTSIDE, 'anywhere', 'new.txt');
    expect(() => guard.resolve(bogus, { forWrite: true })).toThrow();
  });
});

describe('PathGuard — admin mode', () => {
  it('does not jail when enforceJail is false', () => {
    const guard = new PathGuard({ roots: [ALLOWED], enforceJail: false });
    expect(() => guard.resolve(join(OUTSIDE, 'secret.txt'))).not.toThrow();
  });
});

describe('PathGuard — Windows device names', () => {
  it('rejects CON/PRN/AUX/NUL even as relative segments', () => {
    const guard = new PathGuard({ roots: [ALLOWED] });
    expect(() => guard.resolve(join(ALLOWED, 'CON'))).toThrow(/reserved device name/);
    expect(() => guard.resolve(join(ALLOWED, 'sub', 'NUL.txt'))).toThrow(/reserved device name/);
  });
});

describe('PathGuard — input validation', () => {
  it('rejects empty or non-string paths', () => {
    const guard = new PathGuard({ roots: [ALLOWED] });
    expect(() => guard.resolve('')).toThrow();
    // @ts-expect-error testing runtime guard
    expect(() => guard.resolve(null)).toThrow();
  });
});

describe('PathGuard — separator boundary', () => {
  it('root + path.sep is required for containment (literal verification)', () => {
    const guard = new PathGuard({ roots: [ALLOWED] });
    // adjacent path that differs by one character after root: must be rejected
    const candidate = `${ALLOWED}X${sep}inside.txt`;
    mkdirSync(`${ALLOWED}X`, { recursive: true });
    writeFileSync(candidate, 'x');
    expect(() => guard.resolve(candidate)).toThrow(/outside allowed roots/);
    rmSync(`${ALLOWED}X`, { recursive: true, force: true });
  });
});
