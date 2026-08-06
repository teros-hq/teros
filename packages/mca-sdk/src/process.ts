/**
 * Process helpers for MCA handlers.
 *
 * The Turn redesign (TER-319) wires AbortSignal end-to-end from the
 * ConversationManager down to MCA tool handlers. Handlers that spawn child
 * processes should honor `context.signal` to release CPU when a turn is
 * cancelled and to avoid committing side effects after the client has given
 * up waiting for a result.
 *
 * `spawnWithAbort` encapsulates the common pattern (SIGTERM → grace → SIGKILL,
 * listener cleanup, abort-before-start short-circuit) so every MCA doesn't
 * re-implement it. Handlers stay short: pass the signal through, get a typed
 * result describing whether the child exited cleanly or was cancelled.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';

export interface SpawnWithAbortOptions extends Omit<SpawnOptions, 'signal'> {
  /** Aborts the spawned child. SIGTERM first, SIGKILL after `killGraceMs`. */
  signal?: AbortSignal;
  /** Grace window before escalating SIGTERM → SIGKILL. Default 2000ms. */
  killGraceMs?: number;
  /** Called with each stdout chunk (utf-8 decoded). */
  onStdout?: (chunk: string) => void;
  /** Called with each stderr chunk (utf-8 decoded). */
  onStderr?: (chunk: string) => void;
}

export type SpawnWithAbortResult =
  | {
      kind: 'exit';
      exitCode: number;
      signal: NodeJS.Signals | null;
      cancelled: boolean;
    }
  | { kind: 'spawnError'; error: Error };

/**
 * Spawn a child process whose lifecycle is tied to an AbortSignal.
 *
 * Termination policy when `signal` aborts:
 *   1. SIGTERM immediately.
 *   2. After `killGraceMs` (default 2s), SIGKILL if the child is still alive.
 *
 * If `signal` is already aborted before spawn, the function short-circuits
 * with `cancelled: true` and exit code 130 (POSIX convention for SIGINT-like
 * interrupt — `128 + SIGINT(2)`).
 *
 * Both abort listener and the kill escalation timer are cleaned up when the
 * child exits or errors, so callers don't leak handles.
 */
export function spawnWithAbort(
  command: string,
  args: ReadonlyArray<string>,
  opts: SpawnWithAbortOptions = {},
): Promise<SpawnWithAbortResult> {
  const { signal, killGraceMs = 2000, onStdout, onStderr, ...spawnOpts } = opts;

  if (signal?.aborted) {
    return Promise.resolve({
      kind: 'exit',
      exitCode: 130,
      signal: null,
      cancelled: true,
    });
  }

  // Spawn detached so the child becomes the leader of its own process group.
  // This lets us kill the entire tree (the child plus any grandchildren it
  // spawned, e.g. a bash shell that ran `sleep`) by signalling `-pgid`. Without
  // this, killing only the immediate child leaves grandchildren orphaned with
  // pipes still open, and `child.on('close')` waits forever for their stdio.
  const detachedOpts: SpawnOptions = { ...spawnOpts, detached: true };

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args as string[], detachedOpts);
    } catch (error) {
      resolve({ kind: 'spawnError', error: error as Error });
      return;
    }

    const pgid = child.pid;
    let cancelled = false;
    let killEscalator: NodeJS.Timeout | undefined;

    // `child.killed` flips to true on the first `kill()` regardless of whether
    // the process actually died, so we can't reuse it to gate escalation.
    // `exitCode === null` plus our own sigtermSent flag is what we trust.
    let sigtermSent = false;
    const killGroup = (sig: NodeJS.Signals) => {
      if (pgid === undefined) return;
      try {
        process.kill(-pgid, sig);
      } catch {
        // Group may have already exited; ignore ESRCH.
      }
    };
    const onAbort = () => {
      cancelled = true;
      if (child.exitCode !== null || sigtermSent) return;
      sigtermSent = true;
      killGroup('SIGTERM');
      killEscalator = setTimeout(() => {
        if (child.exitCode === null) killGroup('SIGKILL');
      }, killGraceMs);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    if (onStdout && child.stdout) {
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', onStdout);
    }
    if (onStderr && child.stderr) {
      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', onStderr);
    }

    const cleanup = () => {
      if (killEscalator) clearTimeout(killEscalator);
      signal?.removeEventListener('abort', onAbort);
    };

    child.on('close', (code, sig) => {
      cleanup();
      const exitCode = code ?? (sig === 'SIGTERM' || sig === 'SIGKILL' ? 130 : 1);
      resolve({ kind: 'exit', exitCode, signal: sig, cancelled });
    });

    child.on('error', (error) => {
      cleanup();
      resolve({ kind: 'spawnError', error });
    });
  });
}
