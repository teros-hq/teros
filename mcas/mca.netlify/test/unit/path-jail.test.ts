/**
 * Path jail regression tests.
 *
 * Mirrors the bug classes that hit the official MCP filesystem server in 2025
 * (CVE-2025-53109 symlink escape, CVE-2025-53110 prefix-sibling bypass). A leak
 * here means an agent could ship host files into a public Netlify deploy.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathJail } from '../../src/lib/path-jail';

const BASE = join(tmpdir(), `netlify-jail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const ALLOWED = join(BASE, 'workspace');
const ALLOWED_ADJACENT = `${ALLOWED}_adjacent`; // CVE-2025-53110 candidate
const OUTSIDE = join(BASE, 'outside');

beforeEach(() => {
  mkdirSync(join(ALLOWED, 'site'), { recursive: true });
  mkdirSync(ALLOWED_ADJACENT, { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(ALLOWED, 'site', 'index.html'), 'ok');
  writeFileSync(join(OUTSIDE, 'secret.txt'), 'secret');
});

afterEach(() => {
  if (existsSync(BASE)) rmSync(BASE, { recursive: true, force: true });
});

describe('PathJail — containment', () => {
  it('resolves a directory inside the jail', () => {
    const jail = new PathJail(ALLOWED);
    expect(() => jail.resolveDir(join(ALLOWED, 'site'))).not.toThrow();
  });

  it('resolves a relative directory against the root (exact canonical path)', () => {
    const jail = new PathJail(ALLOWED);
    // Pin the EXACT resolved path (canonical root + 'site'), not just a suffix —
    // a suffix match would still pass if the jail resolved somewhere wrong.
    expect(jail.resolveDir('site')).toBe(join(jail.root, 'site'));
  });

  it('allows the jail root itself', () => {
    const jail = new PathJail(ALLOWED);
    expect(() => jail.resolveDir(ALLOWED)).not.toThrow();
  });

  it('rejects an absolute directory outside the jail', () => {
    const jail = new PathJail(ALLOWED);
    expect(() => jail.resolveDir(OUTSIDE)).toThrow(/PATH_ESCAPE/);
  });

  it('rejects relative traversal that escapes to an existing outside dir', () => {
    const jail = new PathJail(ALLOWED);
    expect(() => jail.resolveDir(join('..', 'outside'))).toThrow(/PATH_ESCAPE/);
  });

  it('CVE-2025-53110 — refuses a sibling dir sharing the root prefix', () => {
    // Naive startsWith(root) would accept /…/workspace_adjacent because it
    // starts with /…/workspace. Correct impl uses startsWith(root + sep).
    const jail = new PathJail(ALLOWED);
    expect(() => jail.resolveDir(ALLOWED_ADJACENT)).toThrow(/PATH_ESCAPE/);
  });

  it('CVE-2025-53109 — refuses a symlink whose target is outside the jail', () => {
    const link = join(ALLOWED, 'escape');
    symlinkSync(OUTSIDE, link);
    const jail = new PathJail(ALLOWED);
    expect(() => jail.resolveDir(link)).toThrow(/PATH_ESCAPE/);
  });

  it('throws NOT_FOUND for a non-existent directory', () => {
    const jail = new PathJail(ALLOWED);
    expect(() => jail.resolveDir(join(ALLOWED, 'does-not-exist'))).toThrow(/NOT_FOUND/);
  });

  it('throws INVALID_INPUT for an empty path', () => {
    const jail = new PathJail(ALLOWED);
    expect(() => jail.resolveDir('')).toThrow(/INVALID_INPUT/);
  });
});

describe('PathJail — assertInside', () => {
  it('passes for a path inside the jail', () => {
    const jail = new PathJail(ALLOWED);
    expect(() => jail.assertInside(join(ALLOWED, 'site', 'index.html'))).not.toThrow();
  });

  it('throws for a path outside the jail', () => {
    const jail = new PathJail(ALLOWED);
    expect(() => jail.assertInside(join(OUTSIDE, 'secret.txt'))).toThrow(/PATH_ESCAPE/);
  });
});
