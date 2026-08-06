/**
 * Deadlines for in-turn I/O operations so a frozen dependency can never hang a
 * conversation turn forever. Before TER-650 a hung LLM stream / compaction call
 * / memory-hook query left the session `running` with 0 tokens until the
 * reconciler closed it ~20 min later as `timed_out` — and that wall-clock got
 * billed. These helpers abort the operation quickly instead.
 *
 * Two shapes:
 *   - `withOperationTimeout` — a HARD deadline for one-shot calls (compaction,
 *     memory hooks).
 *   - `createStallGuard` — a REARMABLE watchdog for streaming calls (the LLM
 *     stream): the timer resets on every token so long-but-productive
 *     generations never trip; only a stream that goes silent does.
 */
import { linkAbort } from './linkAbort';

/**
 * Thrown when an in-turn operation exceeds its time budget.
 *
 * Carries `context.errorClass = 'connection'` so the backend's `classifyError`
 * maps it to `network_error` (a frozen socket / unresponsive dependency) and
 * NEVER to `aborted_by_user` — the turn was killed by us, not cancelled by the
 * user. The `name` deliberately avoids the substrings "abort"/"interrupt" that
 * the classifier keys on before it reaches the errorClass. See TER-650.
 */
export class OperationTimeoutError extends Error {
  readonly context = { errorClass: 'connection' as const };
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`Operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = 'OperationTimeoutError';
  }
}

/**
 * Run `op` under a hard deadline. Creates an AbortController linked to the
 * optional parent signal, passes its signal to `op`, and races the operation
 * against a timer. If the timer wins it (a) aborts the derived signal so a
 * well-behaved `op` stops its I/O and (b) rejects with OperationTimeoutError so
 * the caller is freed even if `op` ignores the abort. A parent abort still
 * cancels `op` through the link.
 */
export async function withOperationTimeout<T>(
  operation: string,
  ms: number,
  op: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const ac = new AbortController();
  linkAbort(ac, parentSignal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Single promise (not Promise.race): `op`'s settlement is always consumed
    // by `.then(resolve, reject)`, so if the timer fires first and `op` later
    // rejects via the abort, that late rejection is a no-op reject — no
    // dangling unhandled rejection.
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        const err = new OperationTimeoutError(operation, ms);
        ac.abort(err);
        reject(err);
      }, ms);
      op(ac.signal).then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface StallGuard {
  /** Signal to pass to the streaming operation. */
  readonly signal: AbortSignal;
  /** Reset the stall timer — call on every progress event (token/tool/thinking). */
  kick(): void;
  /** Stop the timer. Call in a `finally` once the operation settles. */
  dispose(): void;
  /** True iff the guard fired its own timeout (vs. a parent/user abort). */
  timedOut(): boolean;
}

/**
 * Two-phase stall windows. Streaming LLMs need a LONGER deadline until the
 * first progress event (time-to-first-token) than between subsequent events:
 * a reasoning/extended-thinking model can legitimately pause many seconds before
 * the first token, but once tokens (or thinking deltas) start flowing a much
 * shorter silence means a frozen socket. This mirrors the idle-timeout pattern
 * used by Vercel AI SDK (`chunkMs`, cleared on the first token) and LangGraph
 * (`idle_timeout` reset on every streamed chunk). TER-650.
 */
export interface StallWindows {
  /** Deadline until the FIRST progress event (TTFT). Kept generous so a slow
   *  first token from a reasoning model is never mistaken for a hang. */
  firstChunkMs: number;
  /** Deadline between subsequent progress events (inter-token). Shorter — once
   *  the stream is productive, silence this long is a frozen socket. */
  interChunkMs: number;
}

/**
 * Accept a bare number as sugar for symmetric windows so legacy call sites
 * (`createStallGuard(op, 120_000)`) keep their exact prior behaviour.
 */
function normalizeWindows(w: number | StallWindows): StallWindows {
  return typeof w === 'number' ? { firstChunkMs: w, interChunkMs: w } : w;
}

/**
 * A rearmable stall watchdog for streaming operations. Unlike
 * `withOperationTimeout`'s hard deadline, the timer resets on every `kick()`,
 * so a stream that keeps emitting tokens never trips — only a stream that goes
 * silent does.
 *
 * Two-phase: the guard arms with `firstChunkMs` (the generous TTFT window); the
 * FIRST `kick()` switches it to `interChunkMs` (the shorter inter-token window)
 * for the rest of the stream. So a reasoning model that pauses before its first
 * token is never cut, while a socket that freezes mid-stream is caught quickly.
 * A bare `number` means symmetric windows (legacy behaviour).
 *
 * On trip it aborts the derived signal with an OperationTimeoutError carrying
 * the window that fired; the caller inspects `timedOut()` to distinguish a stall
 * (→ rethrow as OperationTimeoutError) from a parent/user abort (→ propagate
 * as-is, so it classifies as `aborted_by_user`). See TER-650.
 */
export function createStallGuard(
  operation: string,
  windows: number | StallWindows,
  parentSignal?: AbortSignal,
): StallGuard {
  const { firstChunkMs, interChunkMs } = normalizeWindows(windows);
  const ac = new AbortController();
  linkAbort(ac, parentSignal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tripped = false;
  const armWith = (ms: number) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      tripped = true;
      ac.abort(new OperationTimeoutError(operation, ms));
    }, ms);
  };
  // Initial arm uses the TTFT window; every kick rearms with the (shorter)
  // inter-token window — the first kick is the TTFT→inter-token transition.
  armWith(firstChunkMs);
  return {
    signal: ac.signal,
    kick: () => armWith(interChunkMs),
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
    timedOut: () => tripped,
  };
}

/**
 * Run a streaming operation under a stall guard AND guarantee the caller is
 * freed on trip — even if the operation ignores its AbortSignal.
 *
 * `run(signal, onProgress)` gets the signal to hand to the streaming call and
 * an `onProgress` to call on every chunk (resets the stall timer). The returned
 * promise rejects the instant the signal aborts (via a race against the abort
 * event), so a provider/adapter that fails to honour the signal can no longer
 * hang the turn — the reason for the phantom-billing incident (TER-650). A
 * stall trip is rethrown as OperationTimeoutError (→ network_error); a
 * parent/user abort propagates its own reason (→ aborted_by_user).
 */
export async function runWithStall<T>(
  operation: string,
  windows: number | StallWindows,
  run: (signal: AbortSignal, onProgress: () => void) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  const guard = createStallGuard(operation, windows, parentSignal);
  try {
    return await new Promise<T>((resolve, reject) => {
      // Only a STALL trip force-rejects — that is the guarantee against an op
      // that freezes and ignores its signal. A parent/user abort merely flows
      // into the op's signal and we let the op settle (a real adapter rejects
      // promptly); if it then ignores that too and goes silent, the stall timer
      // still trips. This keeps user-cancel semantics identical to a raw stream.
      const onAbort = () => {
        if (guard.timedOut()) reject(guard.signal.reason);
      };
      if (guard.signal.aborted) onAbort();
      else guard.signal.addEventListener('abort', onAbort, { once: true });
      // `.then(resolve, reject)` consumes run's settlement, so a late rejection
      // after the stall already won the race is a no-op — no unhandled rejection.
      run(guard.signal, guard.kick).then(resolve, reject);
    });
  } catch (err) {
    // A stall trip surfaces as the guard's abort reason — already an
    // OperationTimeoutError carrying the exact window (TTFT vs inter-token) that
    // fired. Prefer it so the message is accurate; fall back to a fresh one only
    // if the op somehow rejected with something else after the stall won.
    if (guard.timedOut()) {
      throw guard.signal.reason instanceof OperationTimeoutError
        ? guard.signal.reason
        : new OperationTimeoutError(operation, normalizeWindows(windows).interChunkMs);
    }
    throw err;
  } finally {
    guard.dispose();
  }
}
