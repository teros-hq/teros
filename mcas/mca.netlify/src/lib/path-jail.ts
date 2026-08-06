/**
 * Path jail for the Netlify MCA.
 *
 * The deploy tool reads files from a caller-supplied directory and ships them to
 * Netlify. The directory MUST stay inside the workspace (`/workspace`) — a path
 * that escapes the jail (via `..`, an absolute path, or a symlink that points
 * outside) would let an agent exfiltrate host files into a public deploy.
 *
 * Adapted from `mcas/mca.teros.filesystem/src/lib/path-safety.ts` (PathGuard),
 * trimmed to the read-only directory-walk case this MCA needs. The containment
 * check uses `startsWith(root + sep)` to avoid the prefix-sibling bypass
 * (CVE-2025-53110: `/workspace_adjacent` must NOT match root `/workspace`), and
 * every check goes through `realpathSync` so a symlink can't smuggle a path out
 * of the jail (CVE-2025-53109).
 */

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export class PathJail {
  /** Canonical (realpath-resolved) workspace root. */
  readonly root: string;

  constructor(root?: string) {
    const base = root ?? process.env.MCA_WORKSPACE_PATH ?? (existsSync('/workspace') ? '/workspace' : process.cwd());
    const absolute = resolve(base);
    try {
      this.root = realpathSync(absolute);
    } catch {
      // Root may not exist yet in tests/dev — keep the lexical path.
      this.root = absolute;
    }
  }

  /**
   * Resolve a caller-supplied directory (relative to the jail root, or absolute)
   * to its canonical path, asserting it exists and stays inside the jail.
   *
   * @throws Error `[INVALID_INPUT]` when the input is empty / not a string.
   * @throws Error `[NOT_FOUND]` when the directory does not exist.
   * @throws Error `[PATH_ESCAPE]` when it resolves outside the jail.
   */
  resolveDir(requested: string): string {
    if (!requested || typeof requested !== 'string') {
      throw new Error('[INVALID_INPUT] dir must be a non-empty string');
    }
    const absolute = isAbsolute(requested) ? requested : resolve(this.root, requested);
    let canonical: string;
    try {
      canonical = realpathSync(absolute);
    } catch {
      throw new Error(`[NOT_FOUND] directory does not exist: ${requested}`);
    }
    this.assertInside(canonical);
    return canonical;
  }

  /**
   * Assert an absolute path is the jail root or strictly inside it. Re-resolves
   * the realpath so a symlink target outside the jail is caught (fail-closed).
   *
   * @throws Error `[PATH_ESCAPE]` when the path escapes the jail.
   */
  assertInside(absolutePath: string): void {
    let real: string;
    try {
      real = realpathSync(absolutePath);
    } catch {
      real = absolutePath;
    }
    if (real !== this.root && !real.startsWith(this.root + sep)) {
      throw new Error(`[PATH_ESCAPE] path escapes the workspace jail: ${absolutePath}`);
    }
  }
}
