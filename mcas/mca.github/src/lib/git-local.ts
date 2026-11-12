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

import { type ChildProcess, spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, resolve, sep } from 'path';
import { agentCloneName, currentGitAgent, currentToolContext } from './git-agent';
import { gitIdentityEnv, resolveGitIdentity } from './git-identity';
import { gitCallTimeLeftMs } from './git-call-budget';
import { renewRepoLease } from './repo-lock';

export interface GitResult {
  stdout: string;
  stderr: string;
  /** Exit status; `-1` when git did not exit normally (see `error`/`signal`). */
  code: number;
  /**
   * Why git did not exit normally — `ENOENT` (no git binary), `ETIMEDOUT`,
   * `ENOBUFS` (output over `maxBuffer`), `EAGAIN`/`EMFILE` (spawn failed).
   */
  error?: { code: string; message: string };
  /** Signal that terminated git, if any (e.g. `SIGKILL` from the OOM killer). */
  signal?: string | null;
  /** git subcommand (`push`, `status`, ...) — for error messages. */
  command?: string;
  /** Timeout this run was given (ms). */
  timeoutMs?: number;
  /** Age of the git lockfile still blocking after the retries (GIT_LOCKED). */
  lockAgeMs?: number;
  budgetCapped?: boolean;
}

export interface ResolveRepoPathArgs {
  /** Absolute path to a cloned repo on the workspace volume. */
  repoPath?: string;
  /** GitHub owner — used to resolve the default `<workspace>/<owner>/<repo>` path. */
  owner?: string;
  /** GitHub repo name — used to resolve the default path (see `defaultRepoPath`). */
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
 * Resolve `target` (absolute, or relative to the workspace root) to an absolute
 * path and verify it stays inside the workspace volume.
 *
 * This is the single containment check shared by every agent-supplied path in
 * this MCA: `resolveRepoPath` (all `git-*` tools) and `clone-repo`'s
 * `destination` (audit 2026-10-01, MEDIUM — clone-repo used to accept any
 * writable path of the container). Throws `GitPathError` (`GIT_INVALID_PATH`)
 * on any escape — parent traversal, absolute foreign path, or a
 * sibling-prefix path (`/workspace-evil` must not pass as "inside" `/workspace`).
 *
 * Returns the normalised absolute path so callers use exactly what was checked.
 */
export function assertInsideWorkspace(target: string): string {
  const workspace = getWorkspacePath();
  const normalized = isAbsolute(target) ? resolve(target) : resolve(workspace, target);
  const workspaceNorm = resolve(workspace);

  // Allow the workspace root itself or any subdirectory; reject parent escapes
  // and prefix-siblings (`/workspace-evil` vs `/workspace`).
  if (normalized !== workspaceNorm && !normalized.startsWith(workspaceNorm + sep)) {
    throw new GitPathError(
      `Resolved path is outside the workspace (${workspaceNorm}): ${normalized}`,
    );
  }

  return normalized;
}

/**
 * `owner/repo` (lower-cased — GitHub names are case-insensitive) of a GitHub
 * remote URL, or `null` for anything else. Tolerates the legacy
 * `x-access-token:<token>@` userinfo still on disk in pre-2026-10-01 clones,
 * a trailing `.git`/`/`, and the scp-like ssh form.
 */
export function githubSlugFromUrl(url: string): string | null {
  const m =
    url.trim().match(/^(?:https?|ssh|git):\/\/(?:[^@/]*@)?github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
    url.trim().match(/^[^@/:]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * `remote.origin.url` of the clone at `repoPath`, read from `.git/config`
 * without spawning git (path resolution is synchronous). `null` when there is
 * no readable config or no origin.
 */
export function readOriginUrl(repoPath: string): string | null {
  let config: string;
  try {
    config = readFileSync(join(repoPath, '.git', 'config'), 'utf-8');
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    const m = inOrigin ? line.match(/^url\s*=\s*(.+)$/) : null;
    if (m) return m[1].trim();
  }
  return null;
}

/** Whether `dir` is a clone whose origin is `owner/repo` on GitHub. */
export function isCloneOf(dir: string, owner: string, repo: string): boolean {
  const origin = readOriginUrl(dir);
  return origin !== null && githubSlugFromUrl(origin) === `${owner}/${repo}`.toLowerCase();
}

/**
 * Where `owner/repo` lives on the workspace volume when no `repoPath` is
 * given (bug-git-github). Clones go to `<workspace>/<owner>/<repo>`: the old
 * `<workspace>/<repo>` layout made `acme/api` and `other/api` collide. Clones
 * made before the change stay usable:
 *
 *  - owner + repo: `<ws>/<owner>/<repo>` if it exists; else the legacy
 *    `<ws>/<repo>` when it is a clone that is not of a *different* GitHub
 *    repo; else `<ws>/<owner>/<repo>` (the "clone it first" path).
 *  - repo only: the legacy `<ws>/<repo>` if it exists; else the single
 *    `<ws>/<any-owner>/<repo>` clone (ambiguous → asks for `owner`).
 */
function agentRepoPath(workspace: string, owner: string | undefined, repo: string, agent: string): string {
  const name = agentCloneName(repo, agent);
  if (owner) {
    const own = join(workspace, owner, name);
    if (existsSync(own)) return own;
    throw new GitPathError(notClonedMessage(`${owner}/${repo}`, join(workspace, owner, repo)));
  }
  let owners: string[] = [];
  try {
    owners = readdirSync(workspace).filter((d) => existsSync(join(workspace, d, name, '.git')));
  } catch {
    owners = [];
  }
  if (owners.length === 1) return join(workspace, owners[0], name);
  if (owners.length > 1) {
    throw new GitPathError(
      `You have several clones named "${repo}" (${owners.map((o) => `${o}/${repo}`).join(', ')}). Pass \`owner\` (or \`repoPath\`) to pick one.`,
    );
  }
  throw new GitPathError(notClonedMessage(repo, null));
}

function notClonedMessage(slug: string, sharedPath: string | null): string {
  const shared = sharedPath && existsSync(join(sharedPath, '.git')) ? sharedPath : null;
  return (
    `You have no clone of ${slug} yet. Each agent works in its own clone, so other agents' branches and changes never mix with yours.\n` +
    `What to do: call clone-repo with owner and repo${slug.includes('/') ? '' : ' (and owner)'}; it is quick when the repo was already cloned in this workspace.` +
    (shared ? ` An older shared clone exists at ${shared}; pass it as \`repoPath\` only if you need work left there.` : '')
  );
}

export function defaultRepoPath(owner: string | undefined, repo: string): string {
  const workspace = getWorkspacePath();
  const agent = currentGitAgent();
  if (agent) return agentRepoPath(workspace, owner, repo, agent);
  const legacy = join(workspace, repo);

  if (owner) {
    const nested = join(workspace, owner, repo);
    if (existsSync(nested)) return nested;
    if (existsSync(join(legacy, '.git'))) {
      const slug = githubSlugFromUrl(readOriginUrl(legacy) ?? '');
      if (slug === null || slug === `${owner}/${repo}`.toLowerCase()) return legacy;
    }
    return nested;
  }

  if (existsSync(join(legacy, '.git'))) return legacy;
  let owners: string[] = [];
  try {
    owners = readdirSync(workspace).filter((d) => existsSync(join(workspace, d, repo, '.git')));
  } catch {
    // Unreadable workspace — fall through to the legacy path.
  }
  if (owners.length === 1) return join(workspace, owners[0], repo);
  if (owners.length > 1) {
    throw new GitPathError(
      `Several clones named "${repo}" exist (${owners.map((o) => `${o}/${repo}`).join(', ')}). Pass \`owner\` (or \`repoPath\`) to pick one.`,
    );
  }
  return legacy;
}

/**
 * Resolve the absolute repo path from the agent-provided arguments. Defaults to
 * `defaultRepoPath(owner, repo)` when `repoPath` is omitted.
 *
 * Throws `GitPathError` when the resolved path escapes the workspace root —
 * prevents an agent from operating on arbitrary host directories.
 */
export function resolveRepoPath(args: ResolveRepoPathArgs): string {
  let target: string;

  if (args.repoPath) {
    target = args.repoPath;
  } else if (args.repo) {
    target = defaultRepoPath(args.owner, args.repo);
  } else {
    throw new GitPathError(
      'Either `repoPath` (absolute path to a cloned repo) or `repo` (name; resolved against the workspace) must be provided.',
    );
  }

  return assertInsideWorkspace(target);
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

// =============================================================================
// TIMEOUTS
// =============================================================================

/**
 * Per-operation time budgets (bug-git-github, 2026-10-24). The old flat 60 s
 * applied to `push`/`fetch` too, and `clone-repo` used 120 s — the same as the
 * backend's HTTP tool-call timeout (`mca-http-client.ts`, 120 s), so a slow
 * clone surfaced as an opaque backend 504 while git kept running. Both
 * budgets stay below that 120 s so the agent always gets a classified,
 * actionable `GIT_TIMEOUT` instead. Ops can tune them per deployment with
 * `MCA_GIT_TIMEOUT_MS` / `MCA_GIT_NETWORK_TIMEOUT_MS` (e.g. after raising the
 * backend timeout).
 */
export const GIT_TIMEOUTS_MS = {
  /** Local working-tree ops (status, add, commit, checkout, log, ...). */
  local: 90_000,
  /** Ops that talk to the remote (clone, fetch, pull, push, ls-remote). */
  network: 110_000,
} as const;

const NETWORK_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);

/**
 * The git subcommand of an argv (`['-c', 'x=y', 'push', ...]` → `push`):
 * skips global options and the value of the ones that take one (`-c`, `-C`).
 */
export function gitSubcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c' || arg === '-C') {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return '';
}

function envTimeout(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Default timeout (ms) for a git argv, honouring the env overrides. */
export function defaultGitTimeout(args: readonly string[]): number {
  return NETWORK_SUBCOMMANDS.has(gitSubcommand(args))
    ? (envTimeout('MCA_GIT_NETWORK_TIMEOUT_MS') ?? GIT_TIMEOUTS_MS.network)
    : (envTimeout('MCA_GIT_TIMEOUT_MS') ?? GIT_TIMEOUTS_MS.local);
}

// =============================================================================
// RUNNER
// =============================================================================

export interface RunGitOptions {
  /** Timeout in ms. Defaults to `defaultGitTimeout(args)`. */
  timeout?: number;
  /** Extra env vars, merged over the forced C locale / no-prompt env. */
  env?: NodeJS.ProcessEnv;
  /** Max combined stdout+stderr bytes before git is killed (`ENOBUFS`). */
  maxBuffer?: number;
}

/** 16 MB — git log/diff can be large. */
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/** Grace between SIGTERM (lets git remove its lockfiles) and SIGKILL. */
const KILL_GRACE_MS = 5_000;

const EXIT_DRAIN_MS = 1_000;

/**
 * Spawn git and collect its output without blocking the event loop.
 *
 * Was `spawnSync` (bug-git-github): `mca.github` is a `per-app` container
 * shared by every agent of the workspace, and a synchronous spawn froze the
 * whole process for the duration of each git command — every other tool call
 * (REST tools, other repos, `/health`) queued behind it until the backend's
 * 120 s HTTP timeout fired. This also lets the repo lock wait asynchronously.
 *
 * Same termination policy as `spawnWithAbort` in `@teros/mca-sdk` (detached
 * process group, SIGTERM then SIGKILL), re-implemented here so `lib/` keeps
 * no runtime dependency on the SDK (unit tests run without it built). Spawn
 * and termination failures are reported in `error` with the same codes
 * `spawnSync` uses (`ENOENT`, `ETIMEDOUT`, `ENOBUFS`, `EAGAIN`, ...) instead
 * of being dropped — dropping them is what turned every failure into
 * `GIT_TIMEOUT`.
 */
function spawnGit(
  argv: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxBuffer: number,
): Promise<Omit<GitResult, 'command' | 'timeoutMs'>> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: { code: string; message: string } | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;

    const output = () => ({
      stdout: sanitiseTokens(Buffer.concat(stdout).toString('utf-8')),
      stderr: sanitiseTokens(Buffer.concat(stderr).toString('utf-8')),
    });
    const finish = (result: Omit<GitResult, 'command' | 'timeoutMs'>) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (drainTimer) clearTimeout(drainTimer);
      resolve(result);
    };

    try {
      child = spawn('git', argv, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      finish({ stdout: '', stderr: '', code: -1, error: { code: e.code ?? 'ESPAWN', message: e.message } });
      return;
    }

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // Group already gone (ESRCH).
      }
    };
    const terminate = (code: string, message: string) => {
      if (failure || child.exitCode !== null) return;
      failure = { code, message };
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBuffer) {
        terminate('ENOBUFS', `git output exceeded the ${maxBuffer}-byte limit`);
        return;
      }
      sink.push(chunk);
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));

    timer = setTimeout(
      () => terminate('ETIMEDOUT', `git did not finish within ${timeoutMs} ms`),
      timeoutMs,
    );

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ ...output(), code: -1, error: { code: error.code ?? 'ESPAWN', message: error.message } });
    });
    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      finish({
        ...output(),
        code: failure ? -1 : (code ?? -1),
        signal,
        ...(failure ? { error: failure } : {}),
      });
    };
    child.on('exit', (code, signal) => {
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(code, signal);
      }, EXIT_DRAIN_MS);
    });
    child.on('close', settle);
  });
}

/**
 * Run `git -C <repoPath> <args...>`, returning the captured stdout/stderr/exit
 * code without throwing on non-zero exit.
 *
 * The caller is responsible for inspecting `result.code` and classifying the
 * error (see `_git-error.ts:classifyGitError`).
 */
const COMMIT_WRITING_COMMANDS = new Set(['commit', 'commit-tree', 'merge', 'rebase', 'cherry-pick', 'pull', 'stash', 'tag', 'revert', 'am']);

async function commitIdentityEnv(command: string | undefined): Promise<Record<string, string>> {
  const context = currentToolContext();
  if (!command || !context || !COMMIT_WRITING_COMMANDS.has(command)) return {};
  const identity = await resolveGitIdentity(context);
  return identity ? gitIdentityEnv(identity) : {};
}

export async function runGit(
  repoPath: string,
  args: string[],
  opts: RunGitOptions = {},
): Promise<GitResult> {
  // Force C locale so git always emits English diagnostics. Without this, the
  // host locale leaks (Spanish on macOS dev machines, etc.) and the stderr
  // matchers in `_git-error.ts:classifyGitError` miss matches that only work
  // against English text. `GIT_TERMINAL_PROMPT=0`: a credential prompt has no
  // one to answer it here — fail fast instead of hanging until the timeout.
  const command = gitSubcommand(args);
  const env = {
    ...process.env,
    LC_ALL: 'C',
    LANG: 'C',
    LANGUAGE: 'C',
    GIT_TERMINAL_PROMPT: '0',
    ...(await commitIdentityEnv(command)),
    ...(opts.env ?? {}),
  };
  const wantedMs = opts.timeout ?? defaultGitTimeout(args);

  for (let attempt = 0; ; attempt++) {
    const leftMs = gitCallTimeLeftMs();
    const budgetCapped = leftMs !== undefined && leftMs - KILL_GRACE_MS < wantedMs;
    const timeoutMs = budgetCapped ? Math.max(0, leftMs - KILL_GRACE_MS) : wantedMs;
    if (budgetCapped && timeoutMs === 0) {
      return {
        stdout: '',
        stderr: '',
        code: -1,
        error: { code: 'ETIMEDOUT', message: 'the tool call ran out of time before git started' },
        command,
        timeoutMs,
        budgetCapped,
      };
    }
    // A tool holding the repo lock keeps its lease alive across commands.
    renewRepoLease(repoPath, timeoutMs + KILL_GRACE_MS + LEASE_MARGIN_MS);
    // We always invoke `git -C <repoPath>` so the agent cannot use relative paths
    // that escape the workspace via shell tricks.
    const result = await spawnGit(
      ['-C', repoPath, '-c', 'core.fsmonitor=false', ...args],
      env,
      timeoutMs,
      opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
    );
    const contended = result.code > 0 && isLockContention(result.stderr);
    if (!contended || attempt >= LOCK_RETRY_DELAYS_MS.length) {
      const lockAgeMs = contended ? lockFileAgeMs(result.stderr) : undefined;
      return {
        ...result,
        command,
        timeoutMs,
        ...(budgetCapped ? { budgetCapped } : {}),
        ...(lockAgeMs !== undefined ? { lockAgeMs } : {}),
      };
    }
    // Another git (bash/terminal, which do not take the repo lock) holds one of
    // git's own lockfiles. Git fails instead of waiting — wait for it here.
    const delay = LOCK_RETRY_DELAYS_MS[attempt];
    await new Promise((r) => setTimeout(r, delay + Math.floor(Math.random() * (delay / 2))));
  }
}

/** Slack added to a command's timeout when renewing the repo-lock lease. */
const LEASE_MARGIN_MS = 10_000;

/** Backoff between retries when git reports lockfile contention (~4 s total). */
export const LOCK_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

/**
 * git's own lockfile contention: `Unable to create '<path>.lock': File
 * exists.` (index, refs, config, packed-refs) / "Another git process seems
 * to be running". Not a ref conflict like `cannot lock ref 'a/b': 'a' exists`.
 */
const LOCK_CONTENTION_RE = /\.lock'?: file exists|another git process seems to be running/i;

export function isLockContention(stderr: string): boolean {
  return LOCK_CONTENTION_RE.test(stderr);
}

/** The lockfile git named in its stderr, if any. */
export function lockFileFromStderr(stderr: string): string | undefined {
  return stderr.match(/Unable to create '([^']+\.lock)'/i)?.[1];
}

function lockFileAgeMs(stderr: string): number | undefined {
  const path = lockFileFromStderr(stderr);
  if (!path) return undefined;
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return undefined; // released meanwhile
  }
}

// =============================================================================
// LEGACY REMOTE SANITISATION (audit 2026-10-01)
// =============================================================================

export interface StrippedRemote {
  /** Remote name whose URL was rewritten (e.g. `origin`). */
  name: string;
  /** The credential-free URL that replaced the contaminated one. */
  cleanUrl: string;
}

/**
 * Userinfo section of a remote URL that indicates embedded CREDENTIALS rather
 * than a plain username: the legacy `x-access-token:<token>@` clone pattern,
 * any `user:password` pair, or a `runGit` sanitiser marker (`<REDACTED…>`).
 * A bare username (`ssh://git@github.com/...`) is legitimate and untouched.
 *
 * Detection runs on `runGit` output, which is already token-sanitised — we
 * match the credential *pattern*, never a raw token.
 */
const EMBEDDED_CREDENTIALS_RE =
  /^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]*(?:x-access-token|<REDACTED|:)[^/@\s]*)@/i;

/**
 * Remove credentials embedded in remote URLs of the repo at `repoPath`.
 *
 * Repos cloned by the pre-2026-10-01 `clone-repo` carry the user's GitHub
 * token inside `remote.origin.url` — git persists that URL verbatim in
 * `.git/config`, leaving the credential readable on disk by anything with
 * access to the workspace volume. This rewrites every affected remote with
 * `git remote set-url <name> <clean-url>` (fetch URL, plus an explicitly
 * configured push URL when that one is contaminated too).
 *
 * Best-effort by design: never throws, and returns the remotes that were
 * sanitised (empty when the repo was already clean). The git-* tools call
 * this opportunistically so legacy repos are cleaned the moment they are
 * used again — authenticated operations keep working because push/fetch/
 * pull inject the credential ephemerally via `http.extraheader`.
 */
export async function stripEmbeddedCredentials(repoPath: string): Promise<StrippedRemote[]> {
  const stripped: StrippedRemote[] = [];
  try {
    const listing = await runGit(repoPath, ['remote', '-v']);
    if (listing.code !== 0) return stripped;

    const remotes = new Map<string, { fetch?: string; push?: string }>();
    for (const line of listing.stdout.split('\n')) {
      // `origin\t<url> (fetch)` / `origin\t<url> (push)`
      const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (!match) continue;
      const [, name, url, dir] = match;
      const entry = remotes.get(name) ?? {};
      if (dir === 'fetch') entry.fetch = url;
      else entry.push = url;
      remotes.set(name, entry);
    }

    for (const [name, urls] of remotes) {
      if (urls.fetch && EMBEDDED_CREDENTIALS_RE.test(urls.fetch)) {
        const cleanUrl = urls.fetch.replace(EMBEDDED_CREDENTIALS_RE, '$1');
        const r = await runGit(repoPath, ['remote', 'set-url', name, cleanUrl]);
        if (r.code === 0) stripped.push({ name, cleanUrl });
      }
      // Only rewrite the push URL when it was set explicitly (differs from
      // the fetch URL) and carries credentials; otherwise it follows the
      // fetch URL automatically.
      if (urls.push && urls.push !== urls.fetch && EMBEDDED_CREDENTIALS_RE.test(urls.push)) {
        await runGit(repoPath, [
          'remote',
          'set-url',
          '--push',
          name,
          urls.push.replace(EMBEDDED_CREDENTIALS_RE, '$1'),
        ]);
      }
    }
  } catch {
    // Sanitisation is hygiene, not a precondition — never break the caller.
  }
  return stripped;
}

// =============================================================================
// REMOTE URL POLICY (audit 2026-10-01, MEDIUM — git-remote hardening)
// =============================================================================

/**
 * The only remote URL shape this MCA accepts: a clean GitHub HTTPS URL with
 * no userinfo (so no `user:token@` credentials can be persisted into
 * `.git/config`), no port, no query, and exactly `owner/repo` path segments.
 */
export const GITHUB_REMOTE_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(\.git)?$/;

/**
 * Safe remote-name charset. Remote names are written into `.git/config` and
 * passed as git argv; this rejects shell/URL/git-option metacharacters
 * (including `://`, `@`, `:`, `/`, leading `-`) so a URL can never be smuggled
 * through the `remote` parameter of fetch/push/pull — git accepts a URL in
 * place of a remote name on the command line, which would bypass remotes
 * entirely.
 */
export const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Defense-in-depth for the token-injecting tools (`git-push`/`git-fetch`/
 * `git-pull`): verify the remote git would contact is a clean github.com
 * HTTPS URL BEFORE the `http.extraheader` credential is resolved.
 *
 * Why this matters even with `git-remote` validating `add`/`set-url`: (a)
 * configs written before the fix (or outside this MCA) may already point at
 * foreign hosts, and the extraheader is attached to every URL git contacts —
 * a push/fetch against such a remote would send the user's token to that
 * host; (b) git accepts a URL in place of a remote name, so
 * `remote: "https://attacker.com/x.git"` would bypass remotes entirely.
 *
 * - Rejects `remote` values that are not plain remote names (blocks inline
 *   URLs and option/path metacharacters) with `[GIT_INVALID_INPUT]`.
 * - Reads the remote's EFFECTIVE URLs — `get-url --all` and `get-url --all
 *   --push`, so fetch URL, explicit push URL, and any `url.<base>.insteadOf` /
 *   `pushInsteadOf` rewrites are all covered — and rejects any URL that is
 *   not clean github.com HTTPS with `[GIT_REMOTE_NOT_GITHUB]`. URLs that
 *   still carry credentials (a legacy remote that `stripEmbeddedCredentials`
 *   failed to rewrite) fail the regex too — fail closed.
 * - A charset-valid name with no such remote configured is left to git —
 *   fetch/push treat a bare name as a local path and fail locally with a
 *   classifiable error (a bare name cannot carry the token anywhere).
 *
 * Call BEFORE `resolveUserToken`/extraheader injection, and AFTER
 * `stripEmbeddedCredentials` (so legacy credential URLs are cleaned first).
 */
export const GITHUB_FILE_LIMIT_BYTES = 100 * 1024 * 1024;

export async function oversizedBlobs(
  repoPath: string,
  remote: string,
  branch: string,
  limitBytes = GITHUB_FILE_LIMIT_BYTES,
): Promise<Array<{ path: string; size: number }>> {
  const range = [branch, '--not', `--remotes=${remote}`];
  const filtered = await runGit(repoPath, [
    'rev-list', '--objects', `--filter=blob:limit=${limitBytes}`, '--filter-print-omitted', ...range,
  ]);
  if (filtered.code !== 0) return [];
  const omitted = new Set(
    filtered.stdout.split('\n').filter((l) => l.startsWith('~')).map((l) => l.slice(1).trim()),
  );
  if (omitted.size === 0) return [];
  const all = await runGit(repoPath, ['rev-list', '--objects', ...range]);
  const found: Array<{ path: string; size: number }> = [];
  for (const line of all.stdout.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0 || !omitted.has(line.slice(0, space))) continue;
    const sha = line.slice(0, space);
    omitted.delete(sha);
    const size = await runGit(repoPath, ['cat-file', '-s', sha]);
    found.push({ path: line.slice(space + 1), size: Number(size.stdout.trim()) });
  }
  return found;
}

export async function assertRemoteIsGithubHttps(repoPath: string, remote: string): Promise<void> {
  if (!REMOTE_NAME_RE.test(remote)) {
    throw new Error(
      `[GIT_INVALID_INPUT] Invalid remote name "${remote}": must be a configured remote name matching ${REMOTE_NAME_RE.source} — URLs are not accepted here.`,
    );
  }
  for (const pushFlag of [[], ['--push']] as const) {
    const urls = await runGit(repoPath, ['remote', 'get-url', '--all', ...pushFlag, remote]);
    // Non-zero (typically exit 2 = no such remote): git will fail and
    // classify on its own; a bare name is only ever treated as a local path,
    // never a network URL.
    if (urls.code !== 0) continue;
    for (const url of urls.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (!GITHUB_REMOTE_URL_RE.test(url)) {
        throw new Error(
          `[GIT_REMOTE_NOT_GITHUB] Remote "${remote}" points at "${url}". Only https://github.com/<owner>/<repo>(.git) remotes are allowed — the user's GitHub token is attached to this operation and would be sent to a foreign host. Fix the remote with git-remote (set-url) or remove it.`,
        );
      }
    }
  }
}

/**
 * `git-pull` variant of the guard for calls without an explicit `remote`:
 * git pulls from the current branch's upstream. Resolve which remote that is
 * (`branch.<name>.remote`) and guard it the same way. Best-effort no-op when
 * there is no current branch, no upstream, or the upstream is local (`.` — no
 * network contact); git produces its own classifiable error in those cases.
 * A `branch.<name>.remote` value that is itself a URL (tracking configured
 * directly against a URL) is validated against the policy regex directly.
 */
export async function assertUpstreamRemoteIsGithubHttps(repoPath: string): Promise<void> {
  const branch = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = branch.code === 0 ? branch.stdout.trim() : '';
  if (!name || name === 'HEAD') return; // detached HEAD — git pull fails on its own
  const remote = await runGit(repoPath, ['config', '--get', `branch.${name}.remote`]);
  if (remote.code !== 0) return; // no upstream configured
  const upstream = remote.stdout.trim();
  if (!upstream || upstream === '.') return; // local tracking — no network contact
  if (upstream.includes('://')) {
    if (!GITHUB_REMOTE_URL_RE.test(upstream)) {
      throw new Error(
        `[GIT_REMOTE_NOT_GITHUB] Branch "${name}" tracks "${upstream}". Only https://github.com/<owner>/<repo>(.git) upstreams are allowed — the user's GitHub token is attached to this operation and would be sent to a foreign host.`,
      );
    }
    return;
  }
  await assertRemoteIsGithubHttps(repoPath, upstream);
}

// =============================================================================
// REF VALIDATION (audit 2026-10-01, MEDIUM — git-option injection hardening)
// =============================================================================

/**
 * Safe ref/rev charset. Refs must start alphanumeric (rejects a leading `-`,
 * which git would parse as an option of the subcommand — git-option injection;
 * `runGit` is argv-form so shell injection is already closed, this is
 * defense-in-depth for the subcommand option parser). After the first char we
 * allow the characters that appear in real refs/revs:
 *  - `/` branch hierarchies (`feature/new`), full refs (`refs/heads/main`)
 *  - `.` ranges (`A..B`), dotted tags (`v0.1.0`)
 *  - `_` `-` word chars in branch/tag names
 *  - `~` `^` parent traversal (`HEAD~1`, `HEAD^2`)
 *  - `{}` `@` peel/reflog suffixes (`v1^{}`, `HEAD^{commit}`, `HEAD@{1}`)
 *  - `+` valid in refnames (e.g. `release/+semver`)
 * `:` is deliberately NOT allowed — no ref syntax needs it, and rejecting it
 * also blocks URL-shaped values from ever reaching a ref positional.
 */
export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\/~^{}@+-]*$/;

/**
 * Validate an agent-supplied ref/rev before it is placed in a git argv.
 * Throws `GitPathError` with `[GIT_INVALID_REF]` on anything that could be
 * parsed by git as an option (leading `-`) or that is not a ref-shaped value.
 */
export function assertSafeRef(value: string, field: string): void {
  if (!REF_RE.test(value)) {
    throw new GitPathError(
      `[GIT_INVALID_REF] ${field} must match ${REF_RE.source} (must start alphanumeric — a leading '-' would be parsed as a git option): ${value}`,
    );
  }
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
