import { describe, expect, it } from 'bun:test';
import {
  ChannelWorker,
  WorkerCancelledError,
} from '../../src/conversation/ChannelWorker';
import type { PromptInput } from '../../src/conversation/ConversationManager';
import type { TurnDriver, RunTurnOptions } from '../../src/conversation/TurnDriver';
import type { MessageWithParts } from '../../src/session/types';

/**
 * Test scaffolding: a TurnDriver double that records invocation order and
 * lets each test orchestrate when its turns settle (deterministic FIFO
 * + abort semantics under heavy interleaving without timing flakes).
 */
class FakeTurnDriver {
  public calls: Array<{ input: PromptInput; options: RunTurnOptions }> = [];
  private pending: Array<{
    resolve: (m: MessageWithParts) => void;
    reject: (e: unknown) => void;
  }> = [];

  runTurn = async (input: PromptInput, options: RunTurnOptions): Promise<MessageWithParts> => {
    this.calls.push({ input, options });

    if (options.signal.aborted) {
      throw new Error('aborted before start');
    }

    return new Promise<MessageWithParts>((resolve, reject) => {
      const entry = { resolve, reject };
      this.pending.push(entry);
      options.signal.addEventListener('abort', () => {
        // Remove this entry from pending so a future test-side `driver.resolve()`
        // doesn't target an already-settled turn.
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error('aborted mid-run'));
      });
    });
  };

  /** Resolve the oldest pending turn. */
  resolve(result: MessageWithParts): void {
    const p = this.pending.shift();
    if (!p) throw new Error('no turn awaiting resolution');
    p.resolve(result);
  }

  /** Reject the oldest pending turn. */
  fail(error: Error): void {
    const p = this.pending.shift();
    if (!p) throw new Error('no turn awaiting rejection');
    p.reject(error);
  }

  pendingCount(): number {
    return this.pending.length;
  }
}

async function waitForCalls(driver: FakeTurnDriver, n: number, maxTicks = 20): Promise<void> {
  for (let i = 0; i < maxTicks && driver.calls.length < n; i++) await tick();
  if (driver.calls.length < n) {
    throw new Error(`expected ${n} calls but got ${driver.calls.length}`);
  }
}

/** Swallow rejections on a list of handles so they don't surface as unhandled. */
function swallow(...promises: Array<{ awaitCompletion(): Promise<MessageWithParts> }>): void {
  for (const p of promises) p.awaitCompletion().catch(() => undefined);
}

function makeInput(text: string): PromptInput {
  return {
    sessionID: 'sess_test',
    userId: 'user_test',
    channelId: 'ch_test',
    parts: [{ type: 'text', text }],
  };
}

function makeResult(id: string): MessageWithParts {
  return {
    info: { id, sessionID: 'sess_test', role: 'assistant', time: { created: Date.now() } } as any,
    parts: [],
  };
}

const driverDeps = (driver: FakeTurnDriver) => ({
  turnDriver: driver as unknown as TurnDriver,
  idleTimeoutMs: 100,
});

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('ChannelWorker', () => {
  it('processes items in FIFO order (single + batch drain)', async () => {
    // Single-item path (no queue contention) runs a dedicated turn.
    // Items arriving WHILE the first turn is in flight are batched into
    // ONE follow-up turn whose input is the last item — they share the
    // result by design (the LLM sees all the new user messages at once).
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    const h1 = worker.enqueue(makeInput('one'));
    await waitForCalls(driver, 1);
    expect(driver.calls[0].input.parts[0]).toMatchObject({ text: 'one' });

    // Two more enqueues land WHILE item 1 is still running.
    const h2 = worker.enqueue(makeInput('two'));
    const h3 = worker.enqueue(makeInput('three'));

    // Item 1 finishes → batch drain pulls items 2 + 3 in a single turn
    // (driven by the last enqueued item).
    driver.resolve(makeResult('m1'));
    await waitForCalls(driver, 2);
    expect(driver.calls[1].input.parts[0]).toMatchObject({ text: 'three' });
    expect(driver.calls.length).toBe(2);

    driver.resolve(makeResult('m_batch'));

    const [r1, r2, r3] = await Promise.all([
      h1.awaitCompletion(),
      h2.awaitCompletion(),
      h3.awaitCompletion(),
    ]);
    expect(r1.info.id).toBe('m1');
    expect(r2.info.id).toBe('m_batch');
    expect(r3.info.id).toBe('m_batch');
    await worker.shutdown();
  });

  it('enforces single in-flight: only the head of the queue runs', async () => {
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    const h1 = worker.enqueue(makeInput('a'));
    const h2 = worker.enqueue(makeInput('b'));
    const h3 = worker.enqueue(makeInput('c'));
    swallow(h1, h2, h3);

    await waitForCalls(driver, 1);
    expect(driver.calls.length).toBe(1);
    expect(worker.inspect().queueLen).toBe(2);
    await worker.shutdown();
  });

  it('CORE bug-fix: two rapid enqueues both produce distinct results', async () => {
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    const h1 = worker.enqueue(makeInput('first'));
    const h2 = worker.enqueue(makeInput('second'));

    await waitForCalls(driver, 1);
    driver.resolve(makeResult('result_first'));
    await waitForCalls(driver, 2);
    driver.resolve(makeResult('result_second'));

    const r1 = await h1.awaitCompletion();
    const r2 = await h2.awaitCompletion();
    expect(r1.info.id).toBe('result_first');
    expect(r2.info.id).toBe('result_second');
    await worker.shutdown();
  });

  it('soft abort cancels current item; next item proceeds', async () => {
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    const h1 = worker.enqueue(makeInput('long'));
    const h2 = worker.enqueue(makeInput('short'));

    await waitForCalls(driver, 1);
    await worker.abort({ kind: 'soft', reason: 'user-stop' });

    let r1Err: unknown;
    await h1.awaitCompletion().catch((e) => {
      r1Err = e;
    });
    expect(r1Err).toBeInstanceOf(Error);

    await waitForCalls(driver, 2);
    driver.resolve(makeResult('m2'));
    const r2 = await h2.awaitCompletion();
    expect(r2.info.id).toBe('m2');
    await worker.shutdown();
  });

  it('hard abort cancels current AND purges queue', async () => {
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    const h1 = worker.enqueue(makeInput('active'));
    const h2 = worker.enqueue(makeInput('queued'));
    // Attach rejection handlers up-front so `purgeQueue` doesn't surface
    // an unhandled rejection in the microtask gap before `await expect`.
    const h1Pending = h1.awaitCompletion().catch((e) => e);
    const h2Pending = h2.awaitCompletion().catch((e) => e);

    await waitForCalls(driver, 1);
    await worker.abort({ kind: 'hard' });

    expect(await h1Pending).toBeInstanceOf(Error);
    expect(await h2Pending).toBeInstanceOf(WorkerCancelledError);
    expect(worker.inspect().queueLen).toBe(0);
    await worker.shutdown();
  });

  it('clearQueue removes pending without touching the active item', async () => {
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    const h1 = worker.enqueue(makeInput('active'));
    const h2 = worker.enqueue(makeInput('drop1'));
    const h3 = worker.enqueue(makeInput('drop2'));

    await waitForCalls(driver, 1);
    expect(worker.clearQueue()).toBe(2);

    await expect(h2.awaitCompletion()).rejects.toBeInstanceOf(WorkerCancelledError);
    await expect(h3.awaitCompletion()).rejects.toBeInstanceOf(WorkerCancelledError);

    driver.resolve(makeResult('m1'));
    const r1 = await h1.awaitCompletion();
    expect(r1.info.id).toBe('m1');
    await worker.shutdown();
  });

  it('error isolation: a thrown item does not stop subsequent items', async () => {
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    const h1 = worker.enqueue(makeInput('boom'));
    const h2 = worker.enqueue(makeInput('next'));

    await waitForCalls(driver, 1);
    driver.fail(new Error('boom'));
    await expect(h1.awaitCompletion()).rejects.toThrow('boom');

    await waitForCalls(driver, 2);
    driver.resolve(makeResult('m2'));
    const r2 = await h2.awaitCompletion();
    expect(r2.info.id).toBe('m2');
    await worker.shutdown();
  });

  it('shutdown drain:true waits for in-flight and queued items to settle', async () => {
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    const h1 = worker.enqueue(makeInput('one'));
    const h2 = worker.enqueue(makeInput('two'));

    await waitForCalls(driver, 1);
    const shutdownPromise = worker.shutdown({ drain: true });

    driver.resolve(makeResult('m1'));
    await waitForCalls(driver, 2);
    driver.resolve(makeResult('m2'));

    await shutdownPromise;
    const r1 = await h1.awaitCompletion();
    const r2 = await h2.awaitCompletion();
    expect(r1.info.id).toBe('m1');
    expect(r2.info.id).toBe('m2');
  });

  it('shutdown drain:false rejects pending immediately', async () => {
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    const h1 = worker.enqueue(makeInput('one'));
    const h2 = worker.enqueue(makeInput('two'));

    await waitForCalls(driver, 1);
    await worker.shutdown({ drain: false });

    await expect(h1.awaitCompletion()).rejects.toThrow();
    await expect(h2.awaitCompletion()).rejects.toBeInstanceOf(WorkerCancelledError);
  });

  it('enqueue after shutdown throws', async () => {
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    await worker.shutdown();
    expect(() => worker.enqueue(makeInput('late'))).toThrow();
  });

  it('idle timeout fires onIdleTimeout when queue is empty', async () => {
    const driver = new FakeTurnDriver();
    let timedOut = false;
    const worker = new ChannelWorker('ch_test', {
      turnDriver: driver as unknown as TurnDriver,
      idleTimeoutMs: 30,
      onIdleTimeout: () => {
        timedOut = true;
      },
    });

    const h = worker.enqueue(makeInput('quick'));
    await waitForCalls(driver, 1);
    driver.resolve(makeResult('m1'));
    await h.awaitCompletion();

    await new Promise((r) => setTimeout(r, 80));
    expect(timedOut).toBe(true);
    await worker.shutdown();
  });

  it('exposes the live queue length to the turn driver via getPendingItemCount', async () => {
    // The boundary_aware InterruptStrategy interrupts mid-turn when there
    // are queued items. The hook reads the LIVE queue — items that
    // arrived AFTER the current turn started (next batch). With batch
    // drain, once a turn pulls items, the queue snaps back to 0 for that
    // turn, then refills with anything new that lands.
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    const h1 = worker.enqueue(makeInput('first'));
    await waitForCalls(driver, 1);

    // Before any queued item: 0.
    expect(driver.calls[0].options.getPendingItemCount?.()).toBe(0);

    const h2 = worker.enqueue(makeInput('queued'));
    const h3 = worker.enqueue(makeInput('also-queued'));
    // While item 1 is still in flight, the live count reflects items 2 + 3.
    expect(driver.calls[0].options.getPendingItemCount?.()).toBe(2);

    driver.resolve(makeResult('m1'));
    await h1.awaitCompletion();
    await waitForCalls(driver, 2);
    // Batch drain pulled both items 2 + 3 into this turn → queue empty.
    expect(driver.calls[1].options.getPendingItemCount?.()).toBe(0);

    driver.resolve(makeResult('m_batch'));
    await Promise.all([h2.awaitCompletion(), h3.awaitCompletion()]);
    await worker.shutdown();
  });

  it('awaitStart resolves even when the worker pulls the item synchronously', async () => {
    // The original `item.started` event-based wiring lost the signal when
    // the worker was idle at enqueue time: `processQueue` ran in a
    // microtask that emitted the event before the caller could register a
    // listener. `awaitStart()` is created with the item, so the promise
    // resolution always lands.
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    const h = worker.enqueue(makeInput('start-race'));
    // Subscribe BEFORE giving the loop a chance to advance — the worker
    // shifts and resolves startedPromise during the next microtask.
    let started = false;
    void h.awaitStart().then(() => {
      started = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toBe(true);

    driver.resolve(makeResult('m1'));
    await h.awaitCompletion();
    await worker.shutdown();
  });

  it('awaitStart resolves even for purged items so callers do not hang', async () => {
    // Items dropped via clearQueue() or hard abort still resolve their
    // startedPromise (with the same value) — only awaitCompletion rejects.
    // Otherwise callers awaiting `awaitStart()` to flip a queueState would
    // hang forever for messages the user explicitly purged.
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    const h1 = worker.enqueue(makeInput('current'));
    const h2 = worker.enqueue(makeInput('pending'));

    // Pre-register the completion-failure handler so the rejection from
    // clearQueue() does not surface as unhandled.
    const h2Done = h2.awaitCompletion().catch((e) => e);

    await waitForCalls(driver, 1);
    worker.clearQueue();

    let h2Started = false;
    void h2.awaitStart().then(() => {
      h2Started = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(h2Started).toBe(true);
    const failure = await h2Done;
    expect(failure).toBeInstanceOf(Error);

    driver.resolve(makeResult('m1'));
    await h1.awaitCompletion();
    await worker.shutdown();
  });

  it('caller-side signal aborts only the corresponding item', async () => {
    const driver = new FakeTurnDriver();
    const worker = new ChannelWorker('ch_test', driverDeps(driver));

    const ac = new AbortController();
    const h1 = worker.enqueue(makeInput('cancelable'), ac.signal);
    const h2 = worker.enqueue(makeInput('survivor'));

    await waitForCalls(driver, 1);
    ac.abort(new Error('caller-cancel'));
    await expect(h1.awaitCompletion()).rejects.toThrow();

    await waitForCalls(driver, 2);
    driver.resolve(makeResult('m2'));
    const r2 = await h2.awaitCompletion();
    expect(r2.info.id).toBe('m2');
    await worker.shutdown();
  });
});
