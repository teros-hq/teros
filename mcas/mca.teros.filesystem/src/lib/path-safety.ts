/**
 * PathGuard — path validation for the filesystem MCAs.
 *
 * Two roles, two contracts:
 *
 * - `workspace` (default, mca.teros.filesystem): STRICT `/workspace` prefix.
 *   The user-facing path space is `/workspace/<path>` — the same convention as
 *   mca.teros.bash (container, volume mounted at /workspace) and messaging tool
 *   params. `normalizeVolumePath` requires an initial `workspace` path segment
 *   (exact segment match — `/workspacefoo` does NOT pass), strips it, and
 *   returns the volume-relative path (`/workspace/docs/foo.md` → `/docs/foo.md`).
 *   Anything else — the old bare `/` style, relative paths without the prefix,
 *   `/workspace/../escape` — throws a Forbidden-style error so agents
 *   self-correct on the next call. One canonical form everywhere.
 *
 * - `admin` (MCA_FS_ROLE=admin — retired with mca.teros.admin.filesystem on
 *   2026-10-19, kept until the role is removed): FULL host access.
 *   Paths are host paths used AS-IS — `/opt/teros/...`, `/etc/...`, `/data/...`
 *   work directly, and `/workspace/<path>` resolves naturally through the host
 *   filesystem exactly as a host shell sees it. NO prefix requirement, NO path
 *   special-casing of any kind.
 */

const WINDOWS_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

function hasWindowsDeviceSegment(path: string): boolean {
  const segments = path.split(/[\\/]/);
  for (const segment of segments) {
    const base = segment.split('.')[0]?.toUpperCase();
    if (base && WINDOWS_DEVICE_NAMES.has(base)) return true;
  }
  return false;
}

export type FsRole = 'workspace' | 'admin';

/**
 * Current filesystem role. (The retired admin MCA set MCA_FS_ROLE=admin in its entry
 * before any handler runs; everything else is the jailed workspace role.
 */
export function getFsRole(): FsRole {
  return process.env.MCA_FS_ROLE === 'admin' ? 'admin' : 'workspace';
}

/** Forbidden-style error for paths outside the canonical /workspace form. */
export const FORBIDDEN_OUTSIDE_WORKSPACE =
  'Forbidden: allowing files outside /workspace is not allowed — use /workspace/<path>';

/**
 * Normalize a user-provided path.
 *
 * Workspace role: require the `/workspace` prefix (exact first segment), strip
 * it, and return the volume-relative path. Bare `/workspace` → volume root `/`.
 * Admin role: return the host path as-is — no jail, no prefix requirement.
 */
export function normalizeVolumePath(requestedPath: string): string {
  if (!requestedPath || typeof requestedPath !== 'string') {
    throw new Error('Path must be a non-empty string');
  }

  if (getFsRole() === 'admin') {
    // Admin role: host paths pass through untouched — full host access from /,
    // exactly like a host shell. No prefix requirement, no translation.
    return requestedPath;
  }

  // Make absolute relative to the path-space root
  const absolute = requestedPath.startsWith('/') ? requestedPath : `/${requestedPath}`;

  if (hasWindowsDeviceSegment(absolute)) {
    throw new Error(`Invalid path: reserved device name segment (${requestedPath})`);
  }

  // Strict /workspace prefix: the first path segment must be exactly
  // `workspace` (segment match, NOT substring — `/workspacefoo` fails).
  const segments = absolute.split('/');
  if (segments[1] !== 'workspace') {
    throw new Error(FORBIDDEN_OUTSIDE_WORKSPACE);
  }

  // Normalize the remainder: resolve `.` and `..` segments. A `..` that pops
  // above the volume root (e.g. `/workspace/../foo.md`) normalizes outside
  // /workspace → Forbidden, same as a missing prefix.
  const resolved: string[] = [];
  for (let i = 2; i < segments.length; i++) {
    const part = segments[i];
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (resolved.length === 0) {
        throw new Error(FORBIDDEN_OUTSIDE_WORKSPACE);
      }
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }

  return '/' + resolved.join('/');
}

/**
 * Convert a resolved internal path to the user-facing form.
 *
 * Workspace role: prefix `/workspace` so outputs round-trip with bash
 * (`/docs/foo.md` → `/workspace/docs/foo.md`; volume root `/` → `/workspace`).
 * Admin role: identity — host paths are already user-facing.
 */
export function toUserPath(internalPath: string): string {
  if (getFsRole() === 'admin') return internalPath;
  if (!internalPath || internalPath === '/') return '/workspace';
  return internalPath.startsWith('/')
    ? `/workspace${internalPath}`
    : `/workspace/${internalPath}`;
}

/**
 * Default root path for path-taking tools (list-files, tree-view, find-files,
 * search-in-files). Workspace role: `/workspace` (the volume root).
 * Admin role: `/` (the host root).
 */
export function defaultRootPath(): string {
  return getFsRole() === 'admin' ? '/' : '/workspace';
}

export interface PathGuardOptions {
  /** No longer used — kept for backward compatibility with admin MCA */
  roots?: string[];
  /** No longer used — the role comes from MCA_FS_ROLE */
  enforceJail?: boolean;
}

/**
 * PathGuard — role-aware path validation.
 *
 * `resolve()` / `resolveNoFollow()` return the path the storage layer expects:
 * volume-relative (workspace role) or the host path as-is (admin role).
 */
export class PathGuard {
  constructor(_options: PathGuardOptions = {}) {
    // Options are accepted for backward compatibility but no longer used —
    // the role is read from MCA_FS_ROLE on every resolve.
  }

  /** Workspace role: ['/workspace'] (user-facing). Admin role: ['/'] (host root). */
  get roots(): readonly string[] {
    return getFsRole() === 'admin' ? ['/'] : ['/workspace'];
  }

  /**
   * Resolve a user-provided path to the path the storage layer expects.
   * Workspace role: strict /workspace prefix → volume-relative path.
   * Admin role: host path as-is.
   */
  resolve(requestedPath: string, _options: { forWrite?: boolean } = {}): string {
    return normalizeVolumePath(requestedPath);
  }

  /**
   * Same as resolve() — kept for API compatibility.
   */
  resolveNoFollow(requestedPath: string): string {
    return normalizeVolumePath(requestedPath);
  }
}

let defaultGuard: PathGuard | null = null;

export function getDefaultGuard(): PathGuard {
  if (!defaultGuard) {
    defaultGuard = new PathGuard();
  }
  return defaultGuard;
}

export function resetDefaultGuard(): void {
  defaultGuard = null;
}
