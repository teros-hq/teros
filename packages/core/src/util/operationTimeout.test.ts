import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStallGuard,
  OperationTimeoutError,
  runWithStall,
  withOperationTimeout,
} from './operationTimeout';

describe('OperationTimeoutError', () => {
  it('does NOT classify as a user abort (name has no abort/interrupt; errorClass=connection)', () => {
    const err = new OperationTimeoutError('llm-stream', 120_000);
    expect(err.name).toBe('OperationTimeoutError');
    // The backend classifier keys on these substrings for aborted_by_user.
    expect(err.name.toLowerCase()).not.toContain('abort');
    expect(err.name.toLowerCase()).not.toContain('interrupt');
    // errorClass 'connection' → classifyError maps to network_error.
    expect(err.context.errorClass).toBe('connection');
    expect(err.message).toContain('llm-stream');
    expect(err.message).toContain('120000');
  });
});

describe('withOperationTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves with the operation result when it completes before the deadline', async () => {
    const p = withOperationTimeout('op', 1000, async () => 'done');
    await expect(p).resolves.toBe('done');
  });

  it('rejects with OperationTimeoutError when the operation never settles', async () => {
    // Operation that never resolves — the whole point of the guard.
    const p = withOperationTimeout('hang', 1000, () => new Promise<never>(() => {}));
    const assertion = expect(p).rejects.toBeInstanceOf(OperationTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('aborts the signal handed to the operation on timeout', async () => {
    let captured: AbortSignal | undefined;
    const p = withOperationTimeout('hang', 1000, (signal) => {
      captured = signal;
      return new Promise<never>(() => {});
    });
    expect(captured?.aborted).toBe(false);
    // Attach the rejection handler BEFORE advancing so there is no window where
    // the rejected promise looks unhandled to the runner.
    const assertion = expect(p).rejects.toBeInstanceOf(OperationTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(captured?.aborted).toBe(true);
  });

  it('propagates a parent abort to the operation signal', async () => {
    const parent = new AbortController();
    let captured: AbortSignal | undefined;
    const p = withOperationTimeout(
      'op',
      10_000,
      (signal) => {
        captured = signal;
        return new Promise<never>((_res, rej) => {
          signal.addEventListener('abort', () => rej(new Error('cancelled')));
        });
      },
      parent.signal,
    );
    parent.abort();
    await expect(p).rejects.toThrow('cancelled');
    expect(captured?.aborted).toBe(true);
  });
});

describe('createStallGuard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts un-aborted and does not report a timeout', () => {
    const g = createStallGuard('stream', 1000);
    expect(g.signal.aborted).toBe(false);
    expect(g.timedOut()).toBe(false);
    g.dispose();
  });

  it('aborts and reports timedOut() after the window with no kick', () => {
    const g = createStallGuard('stream', 1000);
    vi.advanceTimersByTime(1000);
    expect(g.signal.aborted).toBe(true);
    expect(g.timedOut()).toBe(true);
  });

  it('never trips while kept alive by kicks (long productive stream)', () => {
    const g = createStallGuard('stream', 1000);
    // Emit a "token" every 500ms for 5x the window — must never trip.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(500);
      g.kick();
    }
    expect(g.signal.aborted).toBe(false);
    expect(g.timedOut()).toBe(false);
    g.dispose();
  });

  it('trips when the stream freezes after some progress (inter-token stall)', () => {
    const g = createStallGuard('stream', 1000);
    vi.advanceTimersByTime(600);
    g.kick(); // one chunk arrived
    vi.advanceTimersByTime(1000); // then silence
    expect(g.signal.aborted).toBe(true);
    expect(g.timedOut()).toBe(true);
  });

  it('dispose() cancels the timer so it never trips afterwards', () => {
    const g = createStallGuard('stream', 1000);
    g.dispose();
    vi.advanceTimersByTime(5000);
    expect(g.signal.aborted).toBe(false);
    expect(g.timedOut()).toBe(false);
  });

  it('a parent abort trips the signal but NOT timedOut() (distinguishes user cancel)', () => {
    const parent = new AbortController();
    const g = createStallGuard('stream', 1000, parent.signal);
    parent.abort();
    expect(g.signal.aborted).toBe(true);
    // Crucial: the caller must be able to tell a user abort from a stall.
    expect(g.timedOut()).toBe(false);
    g.dispose();
  });
});

describe('createStallGuard — two-phase TTFT/inter-token (TER-650)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses the (long) TTFT window before the first kick — a slow first token does not trip', () => {
    const g = createStallGuard('stream', { firstChunkMs: 1000, interChunkMs: 200 });
    // 900ms of pre-first-token silence: under TTFT (1000), over inter-token (200).
    // MUST NOT trip — this is the reasoning-model-pauses-before-first-token case.
    vi.advanceTimersByTime(900);
    expect(g.signal.aborted).toBe(false);
    // …but at the TTFT window it does trip if the first token never arrives.
    vi.advanceTimersByTime(100);
    expect(g.signal.aborted).toBe(true);
    expect(g.timedOut()).toBe(true);
  });

  it('switches to the (short) inter-token window after the first kick', () => {
    const g = createStallGuard('stream', { firstChunkMs: 1000, interChunkMs: 200 });
    vi.advanceTimersByTime(500);
    g.kick(); // first token arrived → now the 200ms inter-token window applies
    // 300ms of silence: under the old TTFT (1000) but OVER inter-token (200) → trips.
    // If the kick did NOT switch windows, this would still be alive → red.
    vi.advanceTimersByTime(300);
    expect(g.signal.aborted).toBe(true);
    expect(g.timedOut()).toBe(true);
  });

  it('a long-but-productive stream never trips (late first token, then steady tokens)', () => {
    const g = createStallGuard('stream', { firstChunkMs: 1000, interChunkMs: 200 });
    vi.advanceTimersByTime(900); // slow first token, still within TTFT
    g.kick();
    // Then a token every 150ms (< 200 inter-token) for a long time — never trips.
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(150);
      g.kick();
    }
    expect(g.signal.aborted).toBe(false);
    expect(g.timedOut()).toBe(false);
    g.dispose();
  });

  it('the trip error carries the window that actually fired (inter-token, not TTFT)', () => {
    const g = createStallGuard('stream', { firstChunkMs: 1000, interChunkMs: 200 });
    vi.advanceTimersByTime(500);
    g.kick();
    vi.advanceTimersByTime(200);
    expect(g.signal.reason).toBeInstanceOf(OperationTimeoutError);
    expect((g.signal.reason as OperationTimeoutError).timeoutMs).toBe(200);
  });

  it('a bare number behaves as symmetric windows (legacy compatibility)', () => {
    const g = createStallGuard('stream', 1000);
    vi.advanceTimersByTime(500);
    g.kick(); // symmetric → still 1000ms window
    vi.advanceTimersByTime(999);
    expect(g.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(g.signal.aborted).toBe(true);
    expect((g.signal.reason as OperationTimeoutError).timeoutMs).toBe(1000);
  });
});

describe('runWithStall', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves with the operation result when it completes', async () => {
    await expect(runWithStall('op', 1000, async () => 'ok')).resolves.toBe('ok');
  });

  it('propagates the exact window that tripped in the thrown timeout (TER-650)', async () => {
    // A stream that opens, emits one chunk, then freezes → inter-token trip.
    const p = runWithStall<string>(
      'stream',
      { firstChunkMs: 1000, interChunkMs: 200 },
      (_signal, onProgress) =>
        new Promise<string>((_res) => {
          setTimeout(onProgress, 500); // one chunk, then silence forever
        }),
    );
    const assertion = expect(p).rejects.toBeInstanceOf(OperationTimeoutError);
    await vi.advanceTimersByTimeAsync(500); // first chunk → inter-token window armed
    await vi.advanceTimersByTimeAsync(200); // inter-token silence → trip
    await assertion;
    await p.catch((e) => expect((e as OperationTimeoutError).timeoutMs).toBe(200));
  });

  it('frees the turn even when the op ignores the abort signal (the core guarantee)', async () => {
    // A provider that never settles AND never honours abort — pre-TER-650 this
    // hung the turn for ~20 min. runWithStall must reject anyway.
    const p = runWithStall('hang', 1000, () => new Promise<never>(() => {}));
    const assertion = expect(p).rejects.toBeInstanceOf(OperationTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('does not trip while onProgress keeps resetting the timer', async () => {
    const p = runWithStall<string>('stream', 1000, (_signal, onProgress) => {
      return new Promise<string>((resolve) => {
        let n = 0;
        const tick = () => {
          onProgress();
          if (++n < 6) setTimeout(tick, 500);
          else resolve('done');
        };
        setTimeout(tick, 500);
      });
    });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toBe('done');
  });

  it('propagates a parent/user abort as its own reason, not a timeout', async () => {
    const parent = new AbortController();
    const userErr = new Error('interrupted by new message');
    const p = runWithStall(
      'stream',
      10_000,
      (signal) =>
        new Promise<never>((_res, rej) => {
          signal.addEventListener('abort', () => rej(signal.reason));
        }),
      parent.signal,
    );
    const assertion = expect(p).rejects.toBe(userErr);
    parent.abort(userErr);
    await assertion;
    // NOT an OperationTimeoutError → will classify as aborted_by_user.
    await p.catch((e) => expect(e).not.toBeInstanceOf(OperationTimeoutError));
  });
});
