import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const WINDOWS_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

function hasWindowsDeviceSegment(absolute: string): boolean {
  const segments = absolute.split(/[\\/]/);
  for (const segment of segments) {
    const base = segment.split('.')[0]?.toUpperCase();
    if (base && WINDOWS_DEVICE_NAMES.has(base)) return true;
  }
  return false;
}

export interface PathGuardOptions {
  roots?: string[];
  enforceJail?: boolean;
}

export class PathGuard {
  private readonly allowedRoots: string[];
  private readonly enforceJail: boolean;

  constructor(options: PathGuardOptions = {}) {
    this.enforceJail = options.enforceJail ?? true;
    const rootsInput = options.roots ?? this.defaultRoots();
    this.allowedRoots = rootsInput.map((r) => {
      const absolute = resolve(r);
      try {
        return realpathSync(absolute);
      } catch {
        return absolute;
      }
    });
  }

  private defaultRoots(): string[] {
    const envRoot = process.env.MCA_WORKSPACE_PATH;
    if (envRoot) return [envRoot];
    if (existsSync('/workspace')) return ['/workspace'];
    return [process.cwd()];
  }

  get roots(): readonly string[] {
    return this.allowedRoots;
  }

  /**
   * Resolve a user-provided path against the jail. Follows the pattern derived
   * from CVE-2025-53109 / CVE-2025-53110:
   *   - pre-resolve realpath of allowed roots at construction
   *   - for existing paths: realpath the full target (fail-closed on error)
   *   - for writes to non-existent paths: realpath the PARENT only (not the fake path)
   *   - containment check uses `startsWith(root + path.sep)` to avoid prefix bypass
   */
  resolve(requestedPath: string, options: { forWrite?: boolean } = {}): string {
    if (!requestedPath || typeof requestedPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }
    const absolute = isAbsolute(requestedPath)
      ? requestedPath
      : resolve(this.allowedRoots[0] ?? process.cwd(), requestedPath);

    if (hasWindowsDeviceSegment(absolute)) {
      throw new Error(`Invalid path: reserved device name segment (${requestedPath})`);
    }

    let canonical: string;
    try {
      canonical = realpathSync(absolute);
    } catch (err) {
      if (!options.forWrite) {
        throw err;
      }
      const parent = realpathSync(dirname(absolute));
      canonical = join(parent, basenameSafe(absolute));
    }

    if (!this.enforceJail) return canonical;

    const allowed = this.allowedRoots.some(
      (root) => canonical === root || canonical.startsWith(root + sep),
    );
    if (!allowed) {
      throw new Error(
        `Path outside allowed roots: ${requestedPath} (resolved: ${canonical}, roots: ${this.allowedRoots.join(', ')})`,
      );
    }
    return canonical;
  }

  /**
   * Version that does NOT follow the symlink of the target; useful for delete/unlink
   * where we must resolve the PARENT realpath but keep the final component as-is
   * (otherwise we'd try to delete the target of the symlink instead of the link).
   */
  resolveNoFollow(requestedPath: string): string {
    if (!requestedPath || typeof requestedPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }
    const absolute = isAbsolute(requestedPath)
      ? requestedPath
      : resolve(this.allowedRoots[0] ?? process.cwd(), requestedPath);

    if (hasWindowsDeviceSegment(absolute)) {
      throw new Error(`Invalid path: reserved device name segment (${requestedPath})`);
    }

    const parent = realpathSync(dirname(absolute));
    const canonical = join(parent, basenameSafe(absolute));

    if (!this.enforceJail) return canonical;

    const allowed = this.allowedRoots.some(
      (root) => canonical === root || canonical.startsWith(root + sep),
    );
    if (!allowed) {
      throw new Error(
        `Path outside allowed roots: ${requestedPath} (resolved: ${canonical})`,
      );
    }
    return canonical;
  }
}

function basenameSafe(p: string): string {
  const parts = p.split(sep);
  return parts[parts.length - 1] || '';
}

let defaultGuard: PathGuard | null = null;

export function getDefaultGuard(): PathGuard {
  if (!defaultGuard) {
    const role = process.env.MCA_FS_ROLE;
    defaultGuard = new PathGuard({
      enforceJail: role !== 'admin',
    });
  }
  return defaultGuard;
}

export function resetDefaultGuard(): void {
  defaultGuard = null;
}
