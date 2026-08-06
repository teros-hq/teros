/**
 * Git CLI helper shared by all `git-*` tools.
 *
 * Wraps `git -C <repoPath> <args...>` with:
 *  - path traversal protection (the agent provides `repoPath`; we resolve it to
 *    absolute and verify the parent is inside the workspace volume).
 *  - argv-form execution (no shell interpolation of args — protects against
 *    command injection if a branch name or file path contains shell metacharacters).
 *  - structured `GitResult { stdout, stderr, code }` so callers can classify
 *    errors before throwing.
 *  - token sanitisation on output (parity with `clone-repo.ts`).
 *  - parsers for the structured output formats we consume (`status --porcelain=v2`,
 *    `log --pretty=format`, `diff --numstat`).
 *
 * The MCA runs in a `containerMode: per-app` container with the workspace
 * volume mounted at `/workspace` (or wherever `MCA_WORKSPACE_PATH` points).
 * All `git` binaries are inherited from `teros/mca-runtime`.
 */

import { type SpawnSyncOptions, spawnSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { isAbsolute, resolve, sep } from 'path';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ResolveRepoPathArgs {
  /** Absolute path to a cloned repo on the workspace volume. */
  repoPath?: string;
  /** GitHub owner — used to resolve the default `<workspace>/<repo>` path. */
  owner?: string;
  /** GitHub repo name — used to resolve the default `<workspace>/<repo>` path. */
  repo?: string;
}

export class GitPathError extends Error {
  readonly code = 'GIT_INVALID_PATH' as const;
}

/**
 * Resolve the workspace root for this MCA process. Mirrors the convention used
 * by `mca.teros.filesystem` (`MCA_WORKSPACE_PATH || /workspace || cwd`).
 */
export function getWorkspacePath(): string {
  const fromEnv = process.env.MCA_WORKSPACE_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (existsSync('/workspace')) return '/workspace';
  return process.cwd();
}

/**
 * Resolve the absolute repo path from the agent-provided arguments. Defaults to
 * `<workspace>/<repo>` when `repoPath` is omitted but `repo` is provided.
 *
 * Throws `GitPathError` when the resolved path escapes the workspace root —
 * prevents an agent from operating on arbitrary host directories.
 */
export function resolveRepoPath(args: ResolveRepoPathArgs): string {
  const workspace = getWorkspacePath();
  let target: string;

  if (args.repoPath) {
    target = isAbsolute(args.repoPath) ? args.repoPath : resolve(workspace, args.repoPath);
  } else if (args.repo) {
    target = resolve(workspace, args.repo);
  } else {
    throw new GitPathError(
      'Either `repoPath` (absolute path to a cloned repo) or `repo` (name; resolved against the workspace) must be provided.',
    );
  }

  const normalized = resolve(target);
  const workspaceNorm = resolve(workspace);

  // Allow the workspace root itself or any subdirectory; reject parent escapes.
  if (normalized !== workspaceNorm && !normalized.startsWith(workspaceNorm + sep)) {
    throw new GitPathError(
      `Resolved repo path is outside the workspace (${workspaceNorm}): ${normalized}`,
    );
  }

  return normalized;
}

/**
 * Verify that `repoPath` is a git repository (i.e. `.git/` exists). Tools that
 * mutate state should call this before doing anything destructive.
 */
export function assertIsRepo(repoPath: string): void {
  const gitDir = resolve(repoPath, '.git');
  if (!existsSync(gitDir)) {
    throw new GitPathError(`Not a git repository: ${repoPath} (missing .git/)`);
  }
  const stat = statSync(gitDir);
  if (!stat.isDirectory() && !stat.isFile()) {
    throw new GitPathError(`Invalid .git entry at ${gitDir} (expected directory or file)`);
  }
}

/**
 * Sanitise stdout/stderr to redact accidental token leaks. Mirrors the
 * sanitisation in `clone-repo.ts` but generalised — any token-shaped substring
 * is replaced. Conservative on false positives: matches the prefix patterns
 * that GitHub tokens use (`ghs_`, `gho_`, `ghp_`, `ghu_`, `ghr_`,
 * `github_pat_`, `Iv1.`, `Iv23`).
 */
function sanitiseTokens(text: string): string {
  if (!text) return text;
  return text
    .replace(/gh[souprt]_[A-Za-z0-9]{16,255}/g, '<REDACTED_GH_TOKEN>')
    .replace(/github_pat_[A-Za-z0-9_]{20,255}/g, '<REDACTED_GH_PAT>')
    .replace(/\bIv[12][0-9]?\.[A-Za-z0-9_-]{10,80}/g, '<REDACTED_GH_CLIENT_ID>')
    .replace(/x-access-token:[^@\s]+@/g, 'x-access-token:<REDACTED>@');
}

/**
 * Run `git -C <repoPath> <args...>` synchronously, returning the captured
 * stdout/stderr/exit code without throwing on non-zero exit.
 *
 * The caller is responsible for inspecting `result.code` and classifying the
 * error (see `_git-error.ts:classifyGitError`).
 */
export function runGit(
  repoPath: string,
  args: string[],
  opts: SpawnSyncOptions = {},
): GitResult {
  // Force C locale so git always emits English diagnostics. Without this, the
  // host locale leaks (Spanish on macOS dev machines, etc.) and the stderr
  // matchers in `_git-error.ts:classifyGitError` miss matches that only work
  // against English text.
  const env = {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    LANGUAGE: 'C',
    ...(opts.env ?? {}),
  };

  // We always invoke `git -C <repoPath>` so the agent cannot use relative paths
  // that escape the workspace via shell tricks.
  const result = spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf-8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024, // 16 MB — git log/diff can be large
    ...opts,
    env,
  });

  return {
    stdout: sanitiseTokens(String(result.stdout ?? '')),
    stderr: sanitiseTokens(String(result.stderr ?? '')),
    code: result.status ?? -1,
  };
}

// =============================================================================
// PARSERS
// =============================================================================

export interface GitStatusEntry {
  path: string;
  /** Single-letter X (index) status: M, A, D, R, C, U, ?, ! */
  staged: string;
  /** Single-letter Y (worktree) status. */
  worktree: string;
  /** For renames: the original path. */
  origPath?: string;
}

export interface GitStatusResult {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  staged: GitStatusEntry[];
  modified: GitStatusEntry[];
  untracked: GitStatusEntry[];
  conflicted: GitStatusEntry[];
  /** Total entries with any kind of change. */
  totalChanges: number;
}

/**
 * Parse `git status --porcelain=v2 --branch` output.
 *
 * Format reference:
 *   https://git-scm.com/docs/git-status#_porcelain_format_version_2
 *
 * Header lines start with `# `. Entry lines start with `1 ` (ordinary changed),
 * `2 ` (renamed), `u ` (unmerged), or `? ` (untracked).
 */
export function parseGitStatusPorcelain(output: string): GitStatusResult {
  const result: GitStatusResult = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    staged: [],
    modified: [],
    untracked: [],
    conflicted: [],
    totalChanges: 0,
  };

  for (const rawLine of output.split('\n')) {
    if (!rawLine) continue;
    const line = rawLine.trimEnd();

    if (line.startsWith('# branch.head')) {
      const head = line.slice('# branch.head '.length);
      if (head === '(detached)') result.detached = true;
      else result.branch = head;
      continue;
    }
    if (line.startsWith('# branch.upstream')) {
      result.upstream = line.slice('# branch.upstream '.length);
      continue;
    }
    if (line.startsWith('# branch.ab')) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        result.ahead = Number.parseInt(match[1], 10);
        result.behind = Number.parseInt(match[2], 10);
      }
      continue;
    }
    if (line.startsWith('# ')) continue; // other header — ignore

    if (line.startsWith('1 ')) {
      // ordinary: `1 XY sub mH mI mW hH hI path`
      const parts = line.split(' ');
      const xy = parts[1];
      const path = parts.slice(8).join(' ');
      const entry: GitStatusEntry = {
        path,
        staged: xy[0],
        worktree: xy[1],
      };
      if (entry.staged !== '.') result.staged.push(entry);
      if (entry.worktree !== '.') result.modified.push(entry);
      result.totalChanges++;
      continue;
    }
    if (line.startsWith('2 ')) {
      // renamed: `2 XY sub mH mI mW hH hI Xscore path<TAB>origPath`
      const parts = line.split(' ');
      const xy = parts[1];
      // The last token contains "path\torigPath"
      const lastTok = parts.slice(9).join(' ');
      const [path, origPath] = lastTok.split('\t');
      const entry: GitStatusEntry = {
        path,
        origPath,
        staged: xy[0],
        worktree: xy[1],
      };
      if (entry.staged !== '.') result.staged.push(entry);
      if (entry.worktree !== '.') result.modified.push(entry);
      result.totalChanges++;
      continue;
    }
    if (line.startsWith('u ')) {
      // unmerged: `u XY sub m1 m2 m3 mW h1 h2 h3 path`
      const parts = line.split(' ');
      const xy = parts[1];
      const path = parts.slice(10).join(' ');
      result.conflicted.push({ path, staged: xy[0], worktree: xy[1] });
      result.totalChanges++;
      continue;
    }
    if (line.startsWith('? ')) {
      const path = line.slice(2);
      result.untracked.push({ path, staged: '?', worktree: '?' });
      result.totalChanges++;
      continue;
    }
    // `! path` (ignored) — skip; the agent rarely cares about ignored files
  }

  return result;
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body?: string;
}

/** Format string used by `runGit log` to produce parseable output. */
export const LOG_PRETTY_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e';

export function parseGitLogPretty(output: string): GitLogEntry[] {
  if (!output) return [];
  return output
    .split('\x1e')
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, shortSha, author, authorEmail, date, subject, body] = rec.split('\x1f');
      const entry: GitLogEntry = { sha, shortSha, author, authorEmail, date, subject };
      if (body?.trim()) entry.body = body.trim();
      return entry;
    });
}

export interface GitDiffStat {
  path: string;
  additions: number;
  deletions: number;
  /** Renames produce `path1 -> path2`; we keep both. */
  origPath?: string;
}

/**
 * Parse `git diff --numstat` output.
 * Each line: `<additions>\t<deletions>\t<path>` (or `-\t-\t<path>` for binary).
 */
export function parseGitDiffNumstat(output: string): GitDiffStat[] {
  return output
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const [add, del, ...pathParts] = line.split('\t');
      const path = pathParts.join('\t');
      const stat: GitDiffStat = {
        path,
        additions: add === '-' ? 0 : Number.parseInt(add, 10) || 0,
        deletions: del === '-' ? 0 : Number.parseInt(del, 10) || 0,
      };
      // Detect rename in path: "old => new" or "{old => new}"
      const renameMatch = path.match(/(.*)\{(.+) => (.+)\}(.*)/);
      if (renameMatch) {
        const [, prefix, oldName, newName, suffix] = renameMatch;
        stat.origPath = `${prefix}${oldName}${suffix}`;
        stat.path = `${prefix}${newName}${suffix}`;
      }
      return stat;
    });
}
