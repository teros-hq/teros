/**
 * Digest unit tests.
 *
 * The SHA1 + deploy-path mapping is the contract Netlify keys on: a wrong hash
 * algorithm, a missing leading slash, or a backslash separator would make every
 * upload mismatch the digest. These tests pin all three against known vectors.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDigest, sha1Hex, toDeployPath, walkDir } from '../../src/lib/digest';
import { PathJail } from '../../src/lib/path-jail';

const BASE = join(tmpdir(), `netlify-digest-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  mkdirSync(BASE, { recursive: true });
});

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true });
});

describe('sha1Hex', () => {
  it('matches the known vector for the empty input', () => {
    expect(sha1Hex(new Uint8Array(0))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('matches the known vector for "hello"', () => {
    expect(sha1Hex(new TextEncoder().encode('hello'))).toBe(
      'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
    );
  });

  it('is lowercase hex', () => {
    const hash = sha1Hex(new TextEncoder().encode('Teros'));
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('toDeployPath', () => {
  it('produces a leading-slash forward-slash path relative to the root', () => {
    expect(toDeployPath(BASE, join(BASE, 'css', 'app.css'))).toBe('/css/app.css');
  });

  it('handles a top-level file', () => {
    expect(toDeployPath(BASE, join(BASE, 'index.html'))).toBe('/index.html');
  });
});

describe('buildDigest', () => {
  it('builds the files map with leading-slash keys and correct SHA1s', async () => {
    writeFileSync(join(BASE, 'index.html'), 'hello');
    mkdirSync(join(BASE, 'css'), { recursive: true });
    writeFileSync(join(BASE, 'css', 'app.css'), 'body{}');

    const jail = new PathJail(BASE);
    const digest = await buildDigest(BASE, jail);

    expect(digest.files['/index.html']).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    expect(digest.files['/css/app.css']).toBe(sha1Hex(new TextEncoder().encode('body{}')));
    expect(digest.list).toHaveLength(2);
    expect(digest.totalSize).toBe('hello'.length + 'body{}'.length);
  });

  it('content-addresses duplicates: one bySha1 entry for identical files', async () => {
    writeFileSync(join(BASE, 'a.txt'), 'same');
    writeFileSync(join(BASE, 'b.txt'), 'same');

    const jail = new PathJail(BASE);
    const digest = await buildDigest(BASE, jail);

    const sha = sha1Hex(new TextEncoder().encode('same'));
    expect(digest.list).toHaveLength(2);
    expect(Object.keys(digest.files)).toHaveLength(2);
    // Both paths share one SHA1 → a single upload satisfies both.
    expect(digest.bySha1.size).toBe(1);
    expect(digest.bySha1.get(sha)).toBeDefined();
  });

  it('skips .git and node_modules', async () => {
    writeFileSync(join(BASE, 'index.html'), 'x');
    mkdirSync(join(BASE, '.git'), { recursive: true });
    writeFileSync(join(BASE, '.git', 'config'), 'secret');
    mkdirSync(join(BASE, 'node_modules'), { recursive: true });
    writeFileSync(join(BASE, 'node_modules', 'pkg.js'), 'junk');

    const jail = new PathJail(BASE);
    const digest = await buildDigest(BASE, jail);

    expect(digest.list).toHaveLength(1);
    expect(digest.files['/index.html']).toBeDefined();
    expect(digest.files['/.git/config']).toBeUndefined();
    expect(digest.files['/node_modules/pkg.js']).toBeUndefined();
  });

  it('returns an empty digest for an empty directory', async () => {
    const jail = new PathJail(BASE);
    const digest = await buildDigest(BASE, jail);
    expect(digest.list).toHaveLength(0);
    expect(Object.keys(digest.files)).toHaveLength(0);
  });
});

describe('walkDir', () => {
  it('walks nested directories', async () => {
    mkdirSync(join(BASE, 'a', 'b'), { recursive: true });
    writeFileSync(join(BASE, 'a', 'b', 'deep.txt'), 'deep');

    const jail = new PathJail(BASE);
    const files = await walkDir(BASE, jail);
    expect(files.map((f) => f.deployPath)).toContain('/a/b/deep.txt');
  });
});

describe('buildDigest — jail integration (symlink escape)', () => {
  it('throws [PATH_ESCAPE] for a symlink inside the dir that targets outside', async () => {
    // The exfiltration vector: a symlink within the deploy dir whose target is a
    // host file outside /workspace. The per-entry realpath check in the walk must
    // refuse it (fail loud), never silently skip or ship the target's bytes.
    const outside = join(tmpdir(), `netlify-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'host secret');
    try {
      writeFileSync(join(BASE, 'index.html'), 'ok');
      symlinkSync(join(outside, 'secret.txt'), join(BASE, 'leak.txt'));

      const jail = new PathJail(BASE);
      await expect(buildDigest(BASE, jail)).rejects.toThrow(/PATH_ESCAPE/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('walkDir — caps', () => {
  it('throws [TOO_MANY_FILES] when the file count exceeds maxFiles', async () => {
    writeFileSync(join(BASE, 'a.txt'), '1');
    writeFileSync(join(BASE, 'b.txt'), '2');
    writeFileSync(join(BASE, 'c.txt'), '3');
    const jail = new PathJail(BASE);
    await expect(
      walkDir(BASE, jail, { maxFiles: 2, maxFileSize: 1_000_000, maxTotalSize: 1_000_000 }),
    ).rejects.toThrow(/\[TOO_MANY_FILES\]/);
  });

  it('throws [TOO_LARGE] when a single file exceeds maxFileSize', async () => {
    writeFileSync(join(BASE, 'big.bin'), 'x'.repeat(50));
    const jail = new PathJail(BASE);
    await expect(
      walkDir(BASE, jail, { maxFiles: 10, maxFileSize: 10, maxTotalSize: 1_000_000 }),
    ).rejects.toThrow(/\[TOO_LARGE\].*big\.bin/);
  });

  it('throws [TOO_LARGE] when the cumulative size exceeds maxTotalSize', async () => {
    writeFileSync(join(BASE, 'a.bin'), 'x'.repeat(8));
    writeFileSync(join(BASE, 'b.bin'), 'y'.repeat(8));
    const jail = new PathJail(BASE);
    await expect(
      walkDir(BASE, jail, { maxFiles: 10, maxFileSize: 100, maxTotalSize: 10 }),
    ).rejects.toThrow(/\[TOO_LARGE\] total/);
  });

  it('accepts a tree that sits exactly at the caps', async () => {
    writeFileSync(join(BASE, 'a.txt'), 'ab'); // 2 bytes
    writeFileSync(join(BASE, 'b.txt'), 'cd'); // 2 bytes
    const jail = new PathJail(BASE);
    const files = await walkDir(BASE, jail, { maxFiles: 2, maxFileSize: 2, maxTotalSize: 4 });
    expect(files).toHaveLength(2);
  });
});
