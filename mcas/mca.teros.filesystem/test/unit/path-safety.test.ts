/**
 * Path safety regression tests.
 *
 * Workspace role (default): normalizeVolumePath enforces the STRICT
 * /workspace prefix — the canonical path form shared with mca.teros.bash.
 * It strips the prefix and returns the volume-relative path; anything else
 * (old bare `/` style, missing prefix, `/workspacefoo`, traversal out)
 * throws a Forbidden-style error so agents self-correct on the next call.
 *
 * Admin role (MCA_FS_ROLE=admin): host paths pass through untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  FORBIDDEN_OUTSIDE_WORKSPACE,
  PathGuard,
  defaultRootPath,
  normalizeVolumePath,
  toUserPath,
} from '../../src/lib/path-safety';

describe('PathGuard — workspace role (strict /workspace prefix)', () => {
  it('strips the /workspace prefix to the volume-relative path', () => {
    const guard = new PathGuard();
    expect(guard.resolve('/workspace/src/file.ts')).toBe('/src/file.ts');
    expect(guard.resolve('/workspace/a.txt')).toBe('/a.txt');
  });

  it('bare /workspace resolves to the volume root', () => {
    const guard = new PathGuard();
    expect(guard.resolve('/workspace')).toBe('/');
  });

  it('rejects the old bare / style with the Forbidden hint', () => {
    const guard = new PathGuard();
    expect(() => guard.resolve('/src/file.ts')).toThrow(FORBIDDEN_OUTSIDE_WORKSPACE);
    expect(() => guard.resolve('/docs/foo.md')).toThrow(FORBIDDEN_OUTSIDE_WORKSPACE);
  });

  it('rejects relative paths without the prefix', () => {
    const guard = new PathGuard();
    expect(() => guard.resolve('src/file.ts')).toThrow(FORBIDDEN_OUTSIDE_WORKSPACE);
    expect(() => guard.resolve('docs/foo.md')).toThrow(FORBIDDEN_OUTSIDE_WORKSPACE);
  });

  it('rejects /workspacefoo — exact segment match, not substring', () => {
    const guard = new PathGuard();
    expect(() => guard.resolve('/workspacefoo')).toThrow(FORBIDDEN_OUTSIDE_WORKSPACE);
    expect(() => guard.resolve('/workspace-x/a.txt')).toThrow(FORBIDDEN_OUTSIDE_WORKSPACE);
  });

  it('rejects /workspace/../escape (normalizes outside /workspace)', () => {
    const guard = new PathGuard();
    expect(() => guard.resolve('/workspace/../foo.md')).toThrow(FORBIDDEN_OUTSIDE_WORKSPACE);
    expect(() => guard.resolve('/workspace/a/../../b.md')).toThrow(FORBIDDEN_OUTSIDE_WORKSPACE);
  });

  it('rejects traversal that would escape the volume root', () => {
    const guard = new PathGuard();
    expect(() => guard.resolve('/workspace/foo/../../../etc/passwd')).toThrow(
      FORBIDDEN_OUTSIDE_WORKSPACE,
    );
  });

  it('normalizes . and .. within the volume', () => {
    const guard = new PathGuard();
    expect(guard.resolve('/workspace/foo/./bar')).toBe('/foo/bar');
    expect(guard.resolve('/workspace/foo/bar/../baz')).toBe('/foo/baz');
  });
});

describe('PathGuard — Windows device names', () => {
  it('rejects CON/PRN/AUX/NUL even as relative segments', () => {
    const guard = new PathGuard();
    expect(() => guard.resolve('/workspace/CON')).toThrow(/reserved device name/);
    expect(() => guard.resolve('/workspace/sub/NUL.txt')).toThrow(/reserved device name/);
  });
});

describe('PathGuard — input validation', () => {
  it('rejects empty or non-string paths', () => {
    const guard = new PathGuard();
    expect(() => guard.resolve('')).toThrow();
    // @ts-expect-error testing runtime guard
    expect(() => guard.resolve(null)).toThrow();
  });
});

describe('PathGuard — roots property', () => {
  it('returns /workspace as the only root (user-facing)', () => {
    const guard = new PathGuard();
    expect(guard.roots).toEqual(['/workspace']);
  });
});

describe('toUserPath — output convention', () => {
  it('prefixes volume paths with /workspace so outputs round-trip with bash', () => {
    expect(toUserPath('/docs/foo.md')).toBe('/workspace/docs/foo.md');
    expect(toUserPath('/')).toBe('/workspace');
  });
});

describe('defaultRootPath', () => {
  it('is /workspace in the workspace role', () => {
    expect(defaultRootPath()).toBe('/workspace');
  });
});

describe('normalizeVolumePath — standalone function', () => {
  it('rejects the bare / style with the Forbidden hint', () => {
    expect(() => normalizeVolumePath('/../../../etc')).toThrow(FORBIDDEN_OUTSIDE_WORKSPACE);
  });
  it('normalizes correctly with the prefix', () => {
    expect(normalizeVolumePath('/workspace/a/./b/../c.txt')).toBe('/a/c.txt');
  });
});

// ============================================================================
// ADMIN ROLE — full host access, no prefix requirement
// ============================================================================

describe('PathGuard — admin role (MCA_FS_ROLE=admin)', () => {
  beforeEach(() => {
    process.env.MCA_FS_ROLE = 'admin';
  });
  afterEach(() => {
    delete process.env.MCA_FS_ROLE;
  });

  it('host paths pass through untouched — no prefix requirement', () => {
    const guard = new PathGuard();
    expect(guard.resolve('/opt/teros/mcas/mca.teros.filesystem/manifest.json')).toBe(
      '/opt/teros/mcas/mca.teros.filesystem/manifest.json',
    );
    expect(guard.resolve('/etc/hostname')).toBe('/etc/hostname');
    expect(guard.resolve('/')).toBe('/');
  });

  it('/workspace/<path> passes through as a plain host path (no translation)', () => {
    const guard = new PathGuard();
    expect(guard.resolve('/workspace/docs/foo.md')).toBe('/workspace/docs/foo.md');
  });

  it('toUserPath is identity in the admin role', () => {
    expect(toUserPath('/opt/teros')).toBe('/opt/teros');
    expect(toUserPath('/workspace/docs')).toBe('/workspace/docs');
  });

  it('defaultRootPath is the host root /', () => {
    expect(defaultRootPath()).toBe('/');
  });

  it('roots reports the host root /', () => {
    const guard = new PathGuard();
    expect(guard.roots).toEqual(['/']);
  });
});
