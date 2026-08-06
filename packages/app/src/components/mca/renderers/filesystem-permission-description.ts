/**
 * Permission description helper for `mca.teros.filesystem` and
 * `mca.teros.admin.filesystem`.
 *
 * Used during `status === 'pending_permission'` to surface stronger
 * natural-language warnings for the destructive subset of filesystem
 * operations (delete, move, write/edit/append, patch, mkdir).
 *
 * Read-only operations (read, list, tree, stat, glob, grep, hash,
 * read-batch, read-media, list-roots) get a friendly explanation but
 * no warning emphasis.
 *
 * Recovered from `getActionDescription` (deleted with PermissionRequestWidget
 * in commit 89838e29). Kept as a per-MCA helper to honor TER-281
 * (each MCA owns its copy).
 */

export interface FilesystemPermissionInput {
  path?: string;
  filePath?: string;
  source?: string;
  destination?: string;
  pattern?: string;
  algorithm?: string;
  paths?: string[];
}

// ─── Path safety heuristics ─────────────────────────────────────────────────
//
// These run BEFORE the per-tool branches. The goal is not full-path
// security validation (the backend sandboxes execution), but to surface a
// stronger warning to the user when the LLM-suggested path is conspicuous:
//   - System-protected directories (Linux + macOS classics).
//   - Sensitive subdirs of $HOME (.ssh, .aws keys, .gnupg, etc).
//   - Parent-directory traversal (`/workspace/../etc/passwd`).
// All of these still let the user `Allow`, but with eyes open.

const SYSTEM_PROTECTED_PREFIXES = [
  '/etc',
  '/System',
  '/Library',
  '/usr',
  '/bin',
  '/sbin',
  '/boot',
  '/var/log',
  '/var/lib',
  '/private/etc',
];

const HOME_SENSITIVE_SUBDIRS = ['.ssh', '.aws', '.gnupg', '.config', '.kube'];

function isSystemProtectedPath(p: string | undefined): boolean {
  if (!p) return false;
  return SYSTEM_PROTECTED_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

function isHomeSensitivePath(p: string | undefined): boolean {
  if (!p) return false;
  return HOME_SENSITIVE_SUBDIRS.some((sub) => p.includes(`/${sub}/`) || p.endsWith(`/${sub}`));
}

function hasParentTraversal(p: string | undefined): boolean {
  if (!p) return false;
  return /(^|\/)\.\.($|\/)/.test(p);
}

/**
 * Returns a warning prefix for paths that need extra caution. Returns
 * `null` if the path is innocuous. Centralises the heuristics so each
 * destructive branch (delete/move/write/edit/append/patch) can prepend
 * the warning consistently.
 */
function pathRisk(p: string | undefined): string | null {
  if (isSystemProtectedPath(p)) {
    return `system-protected path (${p}). Dangerous`;
  }
  if (isHomeSensitivePath(p)) {
    return `sensitive home directory (${p}). Treat as secrets`;
  }
  if (hasParentTraversal(p)) {
    return `path with parent traversal "..": ${p}. Risky — verify the resolved target`;
  }
  return null;
}

/**
 * Build the description shown in `<ToolCallCard description={...}>`
 * during pending_permission for filesystem tools. Receives the *short*
 * tool name (e.g. `delete`, `read`, `move`) — extract via
 * `getShortToolName(toolName)` upstream.
 *
 * Returns `null` when the tool isn't a recognised filesystem op so the
 * renderer falls back to its default description.
 */
export function getFilesystemPermissionDescription(
  shortName: string,
  input: FilesystemPermissionInput | undefined,
): string | null {
  const path = input?.path ?? input?.filePath;
  const source = input?.source;
  const destination = input?.destination;
  const pattern = input?.pattern;

  // ─── Auditing / read-only ─────────────────────────────────────────────
  if (shortName === 'list-roots') {
    return 'Wants to list workspace roots you can access.';
  }
  if (shortName === 'hash') {
    const algo = input?.algorithm ?? 'sha256';
    return path
      ? `Wants to compute the ${algo} hash of: ${path}`
      : `Wants to compute a ${algo} hash.`;
  }
  if (shortName === 'read-batch') {
    const count = Array.isArray(input?.paths) ? input.paths.length : 0;
    return `Wants to read ${count} files in a single batch.`;
  }
  if (shortName === 'read-media') {
    return path
      ? `Wants to read a media file from: ${path}`
      : 'Wants to read a media file (image, PDF, audio, ...).';
  }
  if (shortName === 'read') {
    return path ? `Wants to read file contents from: ${path}` : 'Wants to read file contents.';
  }
  if (shortName === 'list') {
    return path ? `Wants to list directory contents at: ${path}` : 'Wants to list directory contents.';
  }
  if (shortName === 'tree') {
    return path ? `Wants to get a recursive tree view of: ${path}` : 'Wants to get a recursive tree view.';
  }
  if (shortName === 'stat') {
    return path
      ? `Wants to read metadata (size, mtime, type) of: ${path}`
      : 'Wants to read metadata of a path.';
  }
  if (shortName === 'glob') {
    return pattern
      ? `Wants to find files by pattern: ${pattern}`
      : 'Wants to find files by pattern.';
  }
  if (shortName === 'grep') {
    return pattern
      ? `Wants to search file contents for pattern: ${pattern}`
      : 'Wants to search file contents.';
  }

  // ─── Destructive mutations ────────────────────────────────────────────
  if (shortName === 'delete' || shortName === 'remove') {
    const risk = pathRisk(path);
    if (risk) return `Wants to permanently delete a ${risk}. Irreversible.`;
    return path
      ? `Wants to permanently delete a path: ${path}. This action is irreversible.`
      : 'Wants to permanently delete a path. This action is irreversible.';
  }

  if (shortName === 'move' || shortName === 'rename') {
    const sourceRisk = pathRisk(source);
    const destRisk = pathRisk(destination);
    if (sourceRisk) return `Wants to move/rename FROM a ${sourceRisk}.`;
    if (destRisk) return `Wants to move/rename TO a ${destRisk}.`;
    if (source && destination) {
      return `Wants to move or rename ${source} → ${destination}.`;
    }
    return 'Wants to move or rename a path.';
  }

  if (shortName === 'copy') {
    const destRisk = pathRisk(destination);
    if (destRisk) return `Wants to copy TO a ${destRisk}.`;
    if (source && destination) {
      return `Wants to copy ${source} → ${destination}.`;
    }
    return 'Wants to copy a path.';
  }

  // ─── Content writes ───────────────────────────────────────────────────
  if (shortName === 'write') {
    const risk = pathRisk(path);
    if (risk) return `Wants to write or modify a ${risk}.`;
    return path ? `Wants to write or modify a file: ${path}` : 'Wants to write or modify a file.';
  }
  if (shortName === 'append') {
    const risk = pathRisk(path);
    if (risk) return `Wants to append content to a ${risk}.`;
    return path ? `Wants to append content to a file: ${path}` : 'Wants to append content to a file.';
  }
  if (shortName === 'edit') {
    const risk = pathRisk(path);
    if (risk) return `Wants to edit in place a ${risk}.`;
    return path
      ? `Wants to edit a file in place (exact string replacement): ${path}`
      : 'Wants to edit a file in place.';
  }
  if (shortName === 'patch') {
    const risk = pathRisk(path);
    if (risk) return `Wants to apply a unified diff patch to a ${risk}.`;
    return path
      ? `Wants to apply a unified diff patch to: ${path}`
      : 'Wants to apply a unified diff patch.';
  }

  if (shortName === 'mkdir') {
    const risk = pathRisk(path);
    if (risk) return `Wants to create a directory inside a ${risk}.`;
    return path ? `Wants to create a directory: ${path}` : 'Wants to create a directory.';
  }

  return null;
}
