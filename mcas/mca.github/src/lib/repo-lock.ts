/**
 * Cross-process lock serialising the mutating git tools on one repository
 * (bug-git-github, 2026-10-24).
 *
 * Every agent of a workspace shares one clone on the workspace volume, and
 * several containers mount that volume (`mca.github` per app, plus bash and
 * terminal). Nothing serialised them: two agents committing, checking out or
 * pushing at once raced on `.git/index.lock` and one failed with GIT_LOCKED,
 * or interleaved multi-step tools (rev-parse → push, add → commit).
 *
 * The lock is a file created with `O_EXCL` (`open(..., 'wx')`), atomic on a
 * local filesystem and on NFSv3+/v4 — the workspace volume is NFS on int5.
 * It lives in `.git/` so it never shows in the working tree.
 *
 * Staleness without heartbeats: the holder cannot refresh the file while
 * a git command runs, and PIDs mean nothing across containers. Instead the
 * file's mtime is the lease EXPIRY: set to "now + budget" at acquisition and
 * pushed forward by `renewRepoLease` before every git command the holder
 * runs (by that command's timeout). A holder that crashed or was killed
 * stops renewing, so its lock expires right after its last command could
 * have run, with no fixed multi-minute wait.
 *
 * Git run directly from bash/terminal does not take this lock; for those
 * `runGit` retries git's own `index.lock` contention with backoff.
 *
 * NFS caveat: waiters read the lease through their NFS client's attribute
 * cache (`actimeo`, up to 60 s). Today every container sits on int5 behind
 * one kernel NFS client, so they share that cache; if containers ever mount
 * the volume from different hosts, raise `REPO_LOCK_SKEW_MS` above the
 * attribute-cache lifetime.
 */

import { randomBytes } from 'crypto';
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'fs';
import { hostname } from 'os';
import { join, resolve } from 'path';
import { gitCallTimeLeftMs } from './git-call-budget';

/** File name inside `.git/`. */
export const REPO_LOCK_FILE = 'teros-mca.lock';

/**
 * How long a tool waits for another holder before giving up with GIT_LOCKED
 * (`MCA_GIT_LOCK_WAIT_MS` overrides). Kept well under the backend's 120 s
 * tool-call timeout, which also has to cover the tool's own git commands.
 */
export const REPO_LOCK_WAIT_MS = 45_000;

function defaultWaitMs(): number {
  const fromEnv = Number(process.env.MCA_GIT_LOCK_WAIT_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : REPO_LOCK_WAIT_MS;
}

/**
 * Lease granted at acquisition, before the holder's first git command
 * renews it. Covers the non-git work between commands (token resolution).
 */
export const REPO_LOCK_INITIAL_LEASE_MS = 120_000;

/** Tolerance for clock differences between containers/hosts sharing NFS. */
export const REPO_LOCK_SKEW_MS = 30_000;

export interface RepoLockHolder {
  host: string;
  pid: number;
  tool: string;
  startedAt: string;
  token: string;
}

export interface RepoLockOptions {
  waitMs?: number;
  /** Poll interval cap (ms); polling starts at 50 ms and backs off. */
  maxPollMs?: number;
  initialLeaseMs?: number;
}

/** Locks held by this process, keyed by resolved repo path → lock path. */
const held = new Map<string, Map<string, string>>();

/** Path of the lock for `repoPath`, or `null` when it has no `.git/` directory. */
export function repoLockPath(repoPath: string): string | null {
  const gitDir = join(repoPath, '.git');
  try {
    if (!statSync(gitDir).isDirectory()) return null; // worktree/submodule `.git` file
  } catch {
    return null;
  }
  return join(gitDir, REPO_LOCK_FILE);
}

function setExpiry(lockPath: string, expiresAtMs: number): void {
  const seconds = expiresAtMs / 1000;
  utimesSync(lockPath, seconds, seconds);
}

function readHolder(lockPath: string): Partial<RepoLockHolder> {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<RepoLockHolder>;
  } catch {
    return {}; // being written, or already gone
  }
}

function tryCreate(lockPath: string, holder: RepoLockHolder, leaseMs: number): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    try {
      writeSync(fd, JSON.stringify(holder));
    } finally {
      closeSync(fd);
    }
    setExpiry(lockPath, Date.now() + leaseMs);
  } catch (error) {
    rmSync(lockPath, { force: true });
    throw error;
  }
  return true;
}

/**
 * Remove a lock whose lease expired. Renames it aside first so that two
 * waiters breaking the same stale lock cannot delete a fresh lock the other
 * one just created: if the file we moved is not the stale one we observed,
 * it is put back (`link` fails if the slot was taken meanwhile).
 */
function breakStale(lockPath: string, observedMtimeMs: number): void {
  const aside = `${lockPath}.stale-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return; // released or broken by someone else
  }
  try {
    if (statSync(aside).mtimeMs !== observedMtimeMs) {
      try {
        linkSync(aside, lockPath);
      } catch {
        // Slot already re-taken; nothing to restore.
      }
    }
  } finally {
    try {
      unlinkSync(aside);
    } catch {
      // Already gone.
    }
  }
}

function describeHolder(lockPath: string): string {
  const h = readHolder(lockPath);
  const since = h.startedAt ? Math.round((Date.now() - Date.parse(h.startedAt)) / 1000) : undefined;
  const parts = [h.tool ? `\`${h.tool}\`` : 'a git tool'];
  if (since !== undefined && Number.isFinite(since)) parts.push(`running for ${since} s`);
  if (h.host) parts.push(`in container ${h.host}`);
  return parts.join(', ');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` while holding the repository lock of `repoPath`. Waits (without
 * blocking the event loop) for another holder up to `waitMs`, breaking
 * expired leases, then throws `[GIT_LOCKED]` naming the holder. Repos with
 * no `.git/` directory run unlocked.
 */
export async function withRepoLock<T>(
  repoPath: string,
  tool: string,
  fn: () => Promise<T>,
  opts: RepoLockOptions = {},
): Promise<T> {
  const key = resolve(repoPath);
  const lockPath = repoLockPath(key);
  if (!lockPath) return fn();
  return withLockFile(lockPath, key, tool, fn, opts, (holder, waitedS) =>
    `[GIT_LOCKED] Another agent is using this repository: ${holder}. Waited ${waitedS} s.\n` +
    `What to do: retry in a minute; agents sharing a clone take turns for writes (commit, checkout, push...). The lock frees itself if that tool crashed (${lockPath}).`,
  );
}

/**
 * Lock primitive behind `withRepoLock`, also used by `clone-repo` to lock a
 * destination that does not exist yet. `leaseKey` is the path `runGit` is
 * invoked with while the lock is held, so `renewRepoLease` finds it.
 * `busyMessage` builds the error thrown when the wait runs out.
 */
export async function withLockFile<T>(
  lockPath: string,
  leaseKey: string,
  tool: string,
  fn: () => Promise<T>,
  opts: RepoLockOptions,
  busyMessage: (holder: string, waitedS: number) => string,
): Promise<T> {
  const key = resolve(leaseKey);
  const waitMs = Math.max(0, Math.min(opts.waitMs ?? defaultWaitMs(), gitCallTimeLeftMs() ?? Infinity));
  const maxPollMs = opts.maxPollMs ?? 1_000;
  const leaseMs = opts.initialLeaseMs ?? REPO_LOCK_INITIAL_LEASE_MS;
  const holder: RepoLockHolder = {
    host: hostname(),
    pid: process.pid,
    tool,
    startedAt: new Date().toISOString(),
    token: randomBytes(8).toString('hex'),
  };

  const deadline = Date.now() + waitMs;
  let poll = 50;
  while (!tryCreate(lockPath, holder, leaseMs)) {
    let mtimeMs: number | undefined;
    try {
      mtimeMs = statSync(lockPath).mtimeMs;
    } catch {
      continue; // released between our create and stat — try again now
    }
    if (Date.now() > mtimeMs + REPO_LOCK_SKEW_MS) {
      breakStale(lockPath, mtimeMs);
      continue;
    }
    if (Date.now() + poll > deadline) {
      throw new Error(busyMessage(describeHolder(lockPath), Math.round(waitMs / 1000)));
    }
    await sleep(poll);
    poll = Math.min(poll * 2, maxPollMs);
  }

  const locks = held.get(key) ?? new Map<string, string>();
  locks.set(holder.token, lockPath);
  held.set(key, locks);
  try {
    return await fn();
  } finally {
    locks.delete(holder.token);
    if (locks.size === 0 && held.get(key) === locks) held.delete(key);
    // Only remove our own lock: if our lease was broken as stale, the file
    // may now belong to someone else.
    if (readHolder(lockPath).token === holder.token) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already gone.
      }
    }
  }
}

/**
 * Extend this process's lease on `repoPath` (if it holds one) so it covers a
 * git command about to run for up to `durationMs`. Called by `runGit` — also
 * for unlocked tools (git-status) running in this process while a locked one
 * holds the repo, so the expiry only ever moves forward: a short status must
 * not cut the lease of a long push still running.
 */
export function renewRepoLease(repoPath: string, durationMs: number): void {
  const expiresAt = Date.now() + durationMs;
  for (const lockPath of held.get(resolve(repoPath))?.values() ?? []) {
    if (!existsSync(lockPath)) continue;
    try {
      if (statSync(lockPath).mtimeMs < expiresAt) setExpiry(lockPath, expiresAt);
    } catch {
      continue;
    }
  }
}
