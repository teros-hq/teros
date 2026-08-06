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

    const w1 = registry.getOrCreate(CH, deps);
    const w2 = registry.getOrCreate(CH, deps);
    const other = registry.getOrCreate('ch_other', deps);

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

    const stale = registry.getOrCreate(CH, deps);
    await stale.shutdown(); // worker dies OUTSIDE the registry (e.g. mid-close window)

    const fresh = registry.getOrCreate(CH, deps);
    expect(fresh).not.toBe(stale);
    expect(fresh.inspect().lifecycle).toBe('idle');
    // Disposal of the stale one fires BEFORE the replacement's created —
    // listeners (ChannelRunningTracker) must clear per-channel state first,
    // or the replacement leaks as a phantom worker with no tracker.
    expect(log).toEqual([`created:${CH}`, `disposed:${CH}`, `created:${CH}`]);
  });

  it('replaces a draining worker too', async () => {
    const { registry, deps, driver } = mkRegistry();
    const draining = registry.getOrCreate(CH, deps);
    const a = draining.enqueue(mkInput('A'));
    await until(() => driver.turns.length === 1);
    const drainPromise = draining.shutdown({ drain: true });
    expect(draining.inspect().lifecycle).toBe('draining');

    const fresh = registry.getOrCreate(CH, deps);
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
    const worker = registry.getOrCreate(CH, { ...deps, idleTimeoutMs: 50 });
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
    const worker = registry.getOrCreate(CH, deps);
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
    const worker = registry.getOrCreate(CH, {
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
    const w1 = registry.getOrCreate('ch_1', deps);
    const w2 = registry.getOrCreate('ch_2', deps);
    await registry.closeAll();
    expect(registry.size()).toBe(0);
    expect(w1.inspect().lifecycle).toBe('shutdown');
    expect(w2.inspect().lifecycle).toBe('shutdown');
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
