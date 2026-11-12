/**
 * ChannelWorkerRegistry tests (TER-445).
 *
 * REAL registry + REAL workers over a signal-faithful TurnDriver fake.
 * Covers: lazy creation, stale-worker replacement (disposed BEFORE created —
 * the phantom-worker ordering), idle GC wiring, fatal removal, close/closeAll.
 */

import { describe, expect, it } from 'bun:test';
import type { MessageWithParts } from '../session/types';
import { ChannelWorkerRegistry } from './ChannelWorkerRegistry';
import type { PromptInput } from './ConversationManager';
import type { RunTurnOptions, TurnDriver } from './TurnDriver';

const CH = 'ch_reg';

describe('ChannelWorkerRegistry — creation & lookup', () => {
  it('getOrCreate is lazy and idempotent per channel; emits worker.created once', () => {
    const { registry, deps } = mkRegistry();
    const created: string[] = [];
    registry.on('worker.created', (channelId) => created.push(channelId));

    const w1 = registry.getOrCreate(CH, 'key_a', deps);
    const w2 = registry.getOrCreate(CH, 'key_a', deps);
    const other = registry.getOrCreate('ch_other', 'key_a', deps);

    expect(w1).toBe(w2);
    expect(other).not.toBe(w1);
    expect(created).toEqual([CH, 'ch_other']);
    expect(registry.has(CH)).toBe(true);
    expect(registry.size()).toBe(2);
  });

  it('replaces a stale (shut down) worker, emitting disposed BEFORE created', async () => {
    const { registry, deps } = mkRegistry();
    const log: string[] = [];
    registry.on('worker.created', (channelId) => log.push(`created:${channelId}`));
    registry.on('worker.disposed', (channelId) => log.push(`disposed:${channelId}`));

    const stale = registry.getOrCreate(CH, 'key_a', deps);
    await stale.shutdown(); // worker dies OUTSIDE the registry (e.g. mid-close window)

    const fresh = registry.getOrCreate(CH, 'key_a', deps);
    expect(fresh).not.toBe(stale);
    expect(fresh.inspect().lifecycle).toBe('idle');
    // Disposal of the stale one fires BEFORE the replacement's created —
    // listeners (ChannelRunningTracker) must clear per-channel state first,
    // or the replacement leaks as a phantom worker with no tracker.
    expect(log).toEqual([`created:${CH}`, `disposed:${CH}`, `created:${CH}`]);
  });

  it('replaces a draining worker too', async () => {
    const { registry, deps, driver } = mkRegistry();
    const draining = registry.getOrCreate(CH, 'key_a', deps);
    const a = draining.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    const drainPromise = draining.shutdown({ drain: true });
    expect(draining.inspect().lifecycle).toBe('draining');

    const fresh = registry.getOrCreate(CH, 'key_a', deps);
    expect(fresh).not.toBe(draining);

    driver.turns[0]!.resolve(mkResult('message_ra'));
    await a.awaitCompletion();
    await drainPromise;
  });
});

describe('ChannelWorkerRegistry — removal paths', () => {
  it('close() removes, emits disposed, and shuts the worker down (no-drain)', async () => {
    const { registry, deps, driver } = mkRegistry();
    const disposed: string[] = [];
    registry.on('worker.disposed', (channelId) => disposed.push(channelId));
    // Short idle window so a close() that forgets shutdown() leaves no 5-min
    // timer keeping the test process alive (clean mutant kill instead of a hang).
    const worker = registry.getOrCreate(CH, 'key_a', { ...deps, idleTimeoutMs: 50 });
    const a = worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);

    await registry.close(CH);

    expect(registry.has(CH)).toBe(false);
    expect(disposed).toEqual([CH]);
    await expect(a.awaitCompletion()).rejects.toThrow('shutdown');
    expect(() => worker.enqueue(mkInput('B'))).toThrow('is shut down');
    await registry.close(CH); // double close: no-op, no throw
    expect(disposed).toEqual([CH]);
  });

  it('a worker `fatal` removes it from the registry and emits disposed', async () => {
    const { registry, deps, driver } = mkRegistry();
    const disposed: string[] = [];
    registry.on('worker.disposed', (channelId) => disposed.push(channelId));
    const worker = registry.getOrCreate(CH, 'key_a', deps);
    // Crash the run loop for real: a throwing item.settled listener.
    worker.on('item.settled', () => {
      throw new Error('listener exploded');
    });
    const a = worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    driver.turns[0]!.resolve(mkResult('message_ra'));
    await a.awaitCompletion();

    await until(() => disposed.length === 1);
    expect(registry.has(CH)).toBe(false);
    expect(disposed).toEqual([CH]);
  });

  it('idle GC: the registry closes the worker after its idle window', async () => {
    const { registry, driver } = mkRegistry();
    const worker = registry.getOrCreate(CH, 'key_a', {
      turnDriver: driver as unknown as TurnDriver,
      idleTimeoutMs: 20,
    });
    const a = worker.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    driver.turns[0]!.resolve(mkResult('message_ra'));
    await a.awaitCompletion();

    await until(() => !registry.has(CH));
    expect(worker.inspect().lifecycle).toBe('shutdown');
  });

  it('closeAll shuts every worker down and empties the registry', async () => {
    const { registry, deps } = mkRegistry();
    const w1 = registry.getOrCreate('ch_1', 'key_a', deps);
    const w2 = registry.getOrCreate('ch_2', 'key_a', deps);
    await registry.closeAll();
    expect(registry.size()).toBe(0);
    expect(w1.inspect().lifecycle).toBe('shutdown');
    expect(w2.inspect().lifecycle).toBe('shutdown');
  });
});

describe('ChannelWorkerRegistry — clientKey replacement (TER-617/TER-386)', () => {
  it('same clientKey reuses the same worker (no regression)', () => {
    const { registry, deps } = mkRegistry();
    const w1 = registry.getOrCreate(CH, 'prov_a:model_x', deps);
    const w2 = registry.getOrCreate(CH, 'prov_a:model_x', deps);
    expect(w1).toBe(w2);
    expect(registry.size()).toBe(1);
  });

  it('different clientKey replaces the worker (provider switch mid-conversation)', () => {
    const { registry, deps } = mkRegistry();
    const created: string[] = [];
    const disposed: string[] = [];
    registry.on('worker.created', (ch) => created.push(ch));
    registry.on('worker.disposed', (ch) => disposed.push(ch));

    const w1 = registry.getOrCreate(CH, 'prov_a:model_x', deps);
    // User switches provider mid-conversation → different clientKey
    const w2 = registry.getOrCreate(CH, 'prov_b:model_y', deps);

    expect(w2).not.toBe(w1);
    expect(w2.inspect().lifecycle).toBe('idle');
    // Disposal fires before creation (phantom-worker guard)
    expect(created).toEqual([CH, CH]);
    expect(disposed).toEqual([CH]);
    expect(registry.size()).toBe(1);
  });

  it('cutover flag flip changes the clientKey and replaces the worker', () => {
    const { registry, deps } = mkRegistry();
    // First turn: teros with fallback off → key = 'prov_teros:model_x'
    const w1 = registry.getOrCreate(CH, 'prov_teros:model_x', deps);
    // Second turn: cutover armed → key = 'prov_teros:cutover:model_x'
    const w2 = registry.getOrCreate(CH, 'prov_teros:cutover:model_x', deps);

    expect(w2).not.toBe(w1);
    expect(registry.size()).toBe(1);
  });

  it('replacement with queued items: old worker rejects queued, new worker takes the enqueue', async () => {
    // Immediate-replacement strategy: when the clientKey changes, the old
    // worker is shut down (non-drain). Queued items on the old worker are
    // rejected with WorkerCancelledError. The new worker is ready to accept
    // fresh enqueues. This models the user switching provider: they expect
    // the NEXT message to use the new provider, not to wait for queued
    // turns on the old one to drain.
    const { registry, deps, driver } = mkRegistry();

    // First turn with provider A
    const w1 = registry.getOrCreate(CH, 'prov_a:model_x', deps);
    const a = w1.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);

    // Provider switch mid-conversation → worker replaced
    const w2 = registry.getOrCreate(CH, 'prov_b:model_y', deps);
    expect(w2).not.toBe(w1);

    // The old worker's in-flight item still resolves (the turn was already
    // running when the replacement happened — shutdown aborts it).
    // The new worker is ready for the next message.
    const b = w2.enqueue(mkInput('B'));
    await until(() => driver.turns.length === 2);

    // Resolve both turns
    driver.turns[0]!.resolve(mkResult('message_ra'));
    driver.turns[1]!.resolve(mkResult('message_rb'));

    // The old worker's item may reject (shutdown abort) — catch it
    await a.awaitCompletion().catch(() => undefined);
    const resultB = await b.awaitCompletion();
    expect(resultB.info.id).toBe('message_rb');
  });
});

describe('ChannelWorkerRegistry — turnDriver swap on reuse (incident 2026-10-31)', () => {
  it('reusing a worker swaps its turnDriver to this turn\'s (fresh executor reaches the turn)', async () => {
    // Every prompt() builds a fresh ConversationManager + TurnDriver (fresh
    // toolExecutor). Before the fix, a reused worker ignored the new driver
    // and kept serving turns on the one frozen at its creation — so a newly
    // installed app never became executable mid-conversation.
    const { registry } = mkRegistry();
    const driver1 = new FakeTurnDriver();
    const driver2 = new FakeTurnDriver();

    const w1 = registry.getOrCreate(CH, 'key_a', { turnDriver: driver1 as unknown as TurnDriver });
    // Second turn, same clientKey → worker REUSED …
    const w2 = registry.getOrCreate(CH, 'key_a', { turnDriver: driver2 as unknown as TurnDriver });
    expect(w2).toBe(w1);
    // … but its driver swapped to this turn's.
    expect(w2.getTurnDriver()).toBe(driver2 as unknown as TurnDriver);
  });

  it('the swapped driver serves the NEXT batch (queue and in-flight batch preserved)', async () => {
    const { registry } = mkRegistry();
    const driver1 = new FakeTurnDriver();
    const driver2 = new FakeTurnDriver();

    // Turn 1 on driver1 — batch in flight (runTurn pending).
    const w = registry.getOrCreate(CH, 'key_a', { turnDriver: driver1 as unknown as TurnDriver });
    const a = w.enqueue(mkInput('A'));
    await until(() => driver1.turns.length === 1);

    // Turn 2 arrives while batch 1 is still in flight: worker reused, driver
    // swapped to driver2. Batch 1 is NOT disturbed — it already entered its
    // runTurn on driver1.
    registry.getOrCreate(CH, 'key_a', { turnDriver: driver2 as unknown as TurnDriver });
    expect(w.getTurnDriver()).toBe(driver2 as unknown as TurnDriver);

    // Resolve batch 1 on the OLD driver — it completes normally.
    driver1.turns[0]!.resolve(mkResult('message_ra'));
    await a.awaitCompletion();

    // Batch 2 runs on the NEW driver (the swapped one).
    const b = w.enqueue(mkInput('B'));
    await until(() => driver2.turns.length === 1);
    driver2.turns[0]!.resolve(mkResult('message_rb'));
    const resultB = await b.awaitCompletion();
    expect(resultB.info.id).toBe('message_rb');
    expect(driver1.turns.length).toBe(1);
  });

  it('swapping is skipped when the same driver is passed again (no-op guard)', () => {
    const { registry, deps, driver } = mkRegistry();
    const w1 = registry.getOrCreate(CH, 'key_a', deps);
    const w2 = registry.getOrCreate(CH, 'key_a', deps);
    expect(w2).toBe(w1);
    expect(w2.getTurnDriver()).toBe(driver as unknown as TurnDriver);
  });
});

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

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

function mkRegistry() {
  const registry = new ChannelWorkerRegistry();
  const driver = new FakeTurnDriver();
  const deps = { turnDriver: driver as unknown as TurnDriver };
  return { registry, driver, deps };
}

function mkInput(text: string): PromptInput {
  return {
    sessionID: 'session_r1',
    userId: 'user_1',
    channelId: CH,
    parts: [{ type: 'text', text }],
  };
}

function mkResult(id: string): MessageWithParts {
  return {
    info: { id, sessionID: 'session_r1', role: 'user', time: { created: 1 } },
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
