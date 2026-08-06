/**
 * ChannelWorker tests (TER-445).
 *
 * Real worker against a signal-faithful TurnDriver fake: runTurn rejects when
 * options.signal aborts (including already-aborted signals), exactly like the
 * real driver whose LLM/tool calls reject on abort.
 *
 * Covers: FIFO + batch drain (one LLM turn per cohort), abort soft/hard,
 * clearQueue, shutdown drain/no-drain, idle GC, caller signals, fatal loop
 * errors, inspect snapshots.
 */

import { describe, expect, it } from 'bun:test';
import type { MessageWithParts } from '../session/types';
import { ChannelWorker, WorkerCancelledError } from './ChannelWorker';
import type { PromptInput } from './ConversationManager';
import type { RunTurnOptions, TurnDriver } from './TurnDriver';

const CH = 'ch_test';

describe('ChannelWorker — FIFO + batch drain', () => {
  it('drains the backlog as ONE turn: last input wins, every item resolves with the same result', async () => {
    const { worker, driver } = mkWorker();
    const a = worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);

    // B and C land while A is in flight → they form the next cohort.
    const b = worker.enqueue(mkInput('B'));
    const c = worker.enqueue(mkInput('C'));
    expect(worker.inspect().queueLen).toBe(2);

    driver.turns[0]!.resolve(mkResult('message_ra'));
    await expect(a.awaitCompletion()).resolves.toEqual(mkResult('message_ra'));

    await until(() => driver.turns.length === 2);
    // The batch ran ONCE with the LAST input (B's text never reaches runTurn —
    // the prompt builder reads the whole cohort from the store).
    expect(driver.turns[1]!.input.parts).toEqual([{ type: 'text', text: 'C' }]);

    const result = mkResult('message_rbc');
    driver.turns[1]!.resolve(result);
    const [rb, rc] = await Promise.all([b.awaitCompletion(), c.awaitCompletion()]);
    // Same settled value for every cohort member.
    expect(rb).toBe(rc);
    expect(rb).toEqual(result);
    // Both started (awaitStart resolves) before settling.
    await b.awaitStart();
    await c.awaitStart();
  });

  it('exposes the live queue length to the turn via getPendingItemCount', async () => {
    const { worker, driver } = mkWorker();
    worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    expect(driver.turns[0]!.options.getPendingItemCount?.()).toBe(0);
    worker.enqueue(mkInput('B'));
    expect(driver.turns[0]!.options.getPendingItemCount?.()).toBe(1);
    driver.turns[0]!.resolve(mkResult('message_ra'));
    await until(() => driver.turns.length === 2);
    driver.turns[1]!.resolve(mkResult('message_rb'));
  });

  it('inspect() reflects running and idle states exactly', async () => {
    const { worker, driver } = mkWorker();
    const a = worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    expect(worker.inspect()).toEqual({
      channelId: CH,
      lifecycle: 'running',
      queueLen: 0,
      currentItemId: a.itemId,
      currentPhase: 'building',
    });
    driver.turns[0]!.resolve(mkResult('message_ra'));
    await a.awaitCompletion();
    await until(() => worker.inspect().lifecycle === 'idle');
    expect(worker.inspect()).toEqual({
      channelId: CH,
      lifecycle: 'idle',
      queueLen: 0,
      currentItemId: null,
      currentPhase: null,
    });
  });

  it('setPhase updates the snapshot and emits `phase`', async () => {
    const { worker } = mkWorker();
    const phases: string[] = [];
    worker.on('phase', (p) => phases.push(p));
    worker.setPhase('streaming');
    expect(worker.inspect().currentPhase).toBe('streaming');
    expect(phases).toEqual(['streaming']);
  });
});

describe('ChannelWorker — abort', () => {
  it('soft abort rejects the current item with the exact reason and keeps the queue', async () => {
    const { worker, driver } = mkWorker();
    const a = worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    const b = worker.enqueue(mkInput('B'));

    await worker.abort({ kind: 'soft' });
    await expect(a.awaitCompletion()).rejects.toThrow('stop_message:soft');

    // B survives the soft abort and runs as the next turn.
    await until(() => driver.turns.length === 2);
    expect(driver.turns[1]!.input.parts).toEqual([{ type: 'text', text: 'B' }]);
    driver.turns[1]!.resolve(mkResult('message_rb'));
    await expect(b.awaitCompletion()).resolves.toEqual(mkResult('message_rb'));
  });

  it('soft abort propagates a custom reason', async () => {
    const { worker, driver } = mkWorker();
    const a = worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    await worker.abort({ kind: 'soft', reason: 'agent_revoked' });
    await expect(a.awaitCompletion()).rejects.toThrow('agent_revoked');
  });

  it('hard abort also purges the queue: pending items reject, awaitStart resolves', async () => {
    const { worker, driver } = mkWorker();
    const a = worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    const b = worker.enqueue(mkInput('B'));
    const c = worker.enqueue(mkInput('C'));
    // Register handlers BEFORE the abort: purgeQueue rejects synchronously
    // (real callers await right after enqueue, so there's no unhandled window).
    const settled = [a, b, c].map((h) => h.awaitCompletion().catch((e) => e));

    await worker.abort({ kind: 'hard' });

    expect((await settled[0]) as Error).toEqual(new Error('stop_message:hard'));
    for (const [i, handle] of [b, c].entries()) {
      const err = await settled[i + 1];
      expect(err).toBeInstanceOf(WorkerCancelledError);
      expect((err as Error).message).toBe('worker cancelled: stop_message:hard');
      await handle.awaitStart(); // must NOT hang
    }
    expect(worker.inspect().queueLen).toBe(0);
    expect(driver.turns.length).toBe(1); // purged items never reached the driver
  });

  it('clearQueue purges ONLY pending items (current survives) and returns the count', async () => {
    const { worker, driver } = mkWorker();
    const a = worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    const b = worker.enqueue(mkInput('B'));
    const c = worker.enqueue(mkInput('C'));
    const bSettled = b.awaitCompletion().catch((e) => e);
    const cSettled = c.awaitCompletion().catch((e) => e);

    expect(worker.clearQueue()).toBe(2);

    const errB = await bSettled;
    expect(errB).toBeInstanceOf(WorkerCancelledError);
    expect((errB as Error).message).toBe('worker cancelled: queue_only');
    await cSettled;

    // A is untouched and completes normally.
    driver.turns[0]!.resolve(mkResult('message_ra'));
    await expect(a.awaitCompletion()).resolves.toEqual(mkResult('message_ra'));
    expect(worker.clearQueue()).toBe(0); // empty queue → 0, no throw
  });
});

describe('ChannelWorker — shutdown', () => {
  it('drain:false purges, aborts the in-flight turn, and rejects new enqueues', async () => {
    const { worker, driver } = mkWorker();
    const a = worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    const b = worker.enqueue(mkInput('B'));
    const aSettled = a.awaitCompletion().catch((e) => e);
    const bSettled = b.awaitCompletion().catch((e) => e);

    await worker.shutdown();

    expect(((await aSettled) as Error).message).toBe('shutdown');
    expect(((await bSettled) as Error).message).toBe('worker cancelled: shutdown');
    expect(worker.inspect().lifecycle).toBe('shutdown');
    expect(() => worker.enqueue(mkInput('C'))).toThrow(
      `ChannelWorker[${CH}] is shut down; enqueue rejected`,
    );
  });

  it('drain:true finishes current AND queued items, blocking new enqueues meanwhile', async () => {
    const { worker, driver } = mkWorker();
    const a = worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    const b = worker.enqueue(mkInput('B'));

    const drained = worker.shutdown({ drain: true });
    expect(worker.inspect().lifecycle).toBe('draining');
    expect(() => worker.enqueue(mkInput('C'))).toThrow(
      `ChannelWorker[${CH}] is draining (no new enqueues); enqueue rejected`,
    );

    driver.turns[0]!.resolve(mkResult('message_ra'));
    await until(() => driver.turns.length === 2);
    driver.turns[1]!.resolve(mkResult('message_rb'));

    await drained;
    expect(worker.inspect().lifecycle).toBe('shutdown');
    await expect(a.awaitCompletion()).resolves.toEqual(mkResult('message_ra'));
    await expect(b.awaitCompletion()).resolves.toEqual(mkResult('message_rb'));
  });

  it('double shutdown is a no-op', async () => {
    const { worker } = mkWorker();
    await worker.shutdown();
    await worker.shutdown(); // must not throw
    expect(worker.inspect().lifecycle).toBe('shutdown');
  });
});

describe('ChannelWorker — caller signal', () => {
  it('aborting the caller signal aborts the linked turn', async () => {
    const { worker, driver } = mkWorker();
    const callerAC = new AbortController();
    const a = worker.enqueue(mkInput('A'), callerAC.signal);
    await until(() => driver.turns.length === 1);
    callerAC.abort(new Error('caller cancelled'));
    await expect(a.awaitCompletion()).rejects.toThrow('caller cancelled');
  });

  it('an already-aborted caller signal aborts the turn immediately', async () => {
    const { worker } = mkWorker();
    const callerAC = new AbortController();
    callerAC.abort(new Error('pre-aborted'));
    const a = worker.enqueue(mkInput('A'), callerAC.signal);
    await expect(a.awaitCompletion()).rejects.toThrow('pre-aborted');
  });
});

describe('ChannelWorker — idle GC + fatal', () => {
  it('fires onIdleTimeout after the idle window; an enqueue before it cancels the timer', async () => {
    let fired = 0;
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker(CH, {
      turnDriver: driver as unknown as TurnDriver,
      idleTimeoutMs: 20,
      onIdleTimeout: () => {
        fired += 1;
      },
    });

    const a = worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    driver.turns[0]!.resolve(mkResult('message_ra'));
    await a.awaitCompletion();

    // Re-enqueue within the idle window — the timer must be cancelled.
    await sleep(5);
    const b = worker.enqueue(mkInput('B'));
    await sleep(30);
    expect(fired).toBe(0);

    await until(() => driver.turns.length === 2);
    driver.turns[1]!.resolve(mkResult('message_rb'));
    await b.awaitCompletion();
    await until(() => fired === 1);
    expect(worker.inspect().lifecycle).toBe('idle');
  });

  it('a throwing `item.settled` listener surfaces as a `fatal` event (loop crash)', async () => {
    const { worker, driver } = mkWorker();
    const fatals: unknown[] = [];
    worker.on('fatal', (e) => fatals.push(e));
    worker.on('item.settled', () => {
      throw new Error('listener exploded');
    });
    const a = worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    driver.turns[0]!.resolve(mkResult('message_ra'));
    await a.awaitCompletion();
    await until(() => fatals.length === 1);
    expect((fatals[0] as Error).message).toBe('listener exploded');
  });
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Signal-faithful TurnDriver: each runTurn() parks a controllable turn and
 * rejects when options.signal aborts — including signals aborted BEFORE the
 * call, exactly like the real driver (LLM/tool calls reject on abort).
 */
class FakeTurnDriver {
  turns: Array<{
    input: PromptInput;
    options: RunTurnOptions;
    resolve: (m: MessageWithParts) => void;
    reject: (e: unknown) => void;
  }> = [];

  async runTurn(input: PromptInput, options: RunTurnOptions): Promise<MessageWithParts> {
    return new Promise<MessageWithParts>((resolve, reject) => {
      this.turns.push({ input, options, resolve, reject });
      if (options.signal.aborted) {
        reject(options.signal.reason ?? new Error('aborted'));
        return;
      }
      options.signal.addEventListener(
        'abort',
        () => reject(options.signal.reason ?? new Error('aborted')),
        { once: true },
      );
    });
  }
}

function mkWorker() {
  const driver = new FakeTurnDriver();
  const worker = new ChannelWorker(CH, { turnDriver: driver as unknown as TurnDriver });
  return { worker, driver };
}

function mkInput(text: string): PromptInput {
  return {
    sessionID: 'session_w1',
    userId: 'user_1',
    channelId: CH,
    parts: [{ type: 'text', text }],
  };
}

function mkResult(id: string): MessageWithParts {
  return {
    info: { id, sessionID: 'session_w1', role: 'user', time: { created: 1 } },
    parts: [],
  } as unknown as MessageWithParts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('until(): condition not met in time');
    await sleep(5);
  }
}
