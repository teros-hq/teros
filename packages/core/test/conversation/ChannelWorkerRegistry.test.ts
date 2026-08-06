import { describe, expect, it } from 'bun:test';
import {
  ChannelWorker,
  WorkerCancelledError,
  type ChannelWorkerDeps,
} from '../../src/conversation/ChannelWorker';
import { ChannelWorkerRegistry } from '../../src/conversation/ChannelWorkerRegistry';
import type { PromptInput } from '../../src/conversation/ConversationManager';
import type { TurnDriver } from '../../src/conversation/TurnDriver';
import type { MessageWithParts } from '../../src/session/types';

class IdleTurnDriver {
  calls = 0;
  runTurn = async (): Promise<MessageWithParts> => {
    this.calls++;
    return {
      info: { id: `m${this.calls}`, sessionID: 's', role: 'assistant', time: { created: 0 } } as any,
      parts: [],
    };
  };
}

const makeInput = (text: string): PromptInput => ({
  sessionID: 's',
  userId: 'u',
  channelId: 'c',
  parts: [{ type: 'text', text }],
});

const baseDeps = (driver: IdleTurnDriver): Omit<ChannelWorkerDeps, 'onIdleTimeout'> => ({
  turnDriver: driver as unknown as TurnDriver,
  idleTimeoutMs: 50,
});

describe('ChannelWorkerRegistry', () => {
  it('returns the same worker for repeated getOrCreate calls', () => {
    const registry = new ChannelWorkerRegistry();
    const w1 = registry.getOrCreate('ch1', baseDeps(new IdleTurnDriver()));
    const w2 = registry.getOrCreate('ch1', baseDeps(new IdleTurnDriver()));
    expect(w1).toBe(w2);
    expect(registry.size()).toBe(1);
  });

  it('returns distinct workers per channel', () => {
    const registry = new ChannelWorkerRegistry();
    const w1 = registry.getOrCreate('ch1', baseDeps(new IdleTurnDriver()));
    const w2 = registry.getOrCreate('ch2', baseDeps(new IdleTurnDriver()));
    expect(w1).not.toBe(w2);
    expect(registry.size()).toBe(2);
  });

  it('close removes worker from registry', async () => {
    const registry = new ChannelWorkerRegistry();
    registry.getOrCreate('ch1', baseDeps(new IdleTurnDriver()));
    expect(registry.has('ch1')).toBe(true);
    await registry.close('ch1');
    expect(registry.has('ch1')).toBe(false);
  });

  it('idle timeout auto-removes worker from registry', async () => {
    const registry = new ChannelWorkerRegistry();
    const driver = new IdleTurnDriver();
    const worker = registry.getOrCreate('ch1', baseDeps(driver));
    const handle = worker.enqueue(makeInput('one'));
    await handle.awaitCompletion();
    // Idle timer kicks in after 50ms
    await new Promise((r) => setTimeout(r, 120));
    expect(registry.has('ch1')).toBe(false);
  });

  it('closeAll terminates every worker', async () => {
    const registry = new ChannelWorkerRegistry();
    registry.getOrCreate('a', baseDeps(new IdleTurnDriver()));
    registry.getOrCreate('b', baseDeps(new IdleTurnDriver()));
    registry.getOrCreate('c', baseDeps(new IdleTurnDriver()));
    expect(registry.size()).toBe(3);
    await registry.closeAll();
    expect(registry.size()).toBe(0);
  });

  it('fatal worker error self-removes from registry', async () => {
    const registry = new ChannelWorkerRegistry();
    const worker = registry.getOrCreate('ch1', baseDeps(new IdleTurnDriver()));
    expect(registry.has('ch1')).toBe(true);
    // Simulate a fatal by emitting directly — production fatal arrives via
    // the run-loop .catch path; same registry response.
    worker.emit('fatal', new Error('synthetic fatal'));
    expect(registry.has('ch1')).toBe(false);
    await worker.shutdown();
  });

  it('getOrCreate replaces stale workers stuck in shutdown/draining lifecycle', async () => {
    // Regression for the latent bug where `getOrCreate` returned a worker
    // already in `lifecycle:'shutdown'` (e.g. between `close()`'s map-delete
    // and `worker.disposed` emit, OR if a caller held the reference past
    // shutdown). That stale worker rejects every new `enqueue` — the user
    // sees their next message vanish silently.
    const registry = new ChannelWorkerRegistry();
    const w1 = registry.getOrCreate('ch1', baseDeps(new IdleTurnDriver()));
    await w1.shutdown({ drain: false });
    expect(w1.inspect().lifecycle).toBe('shutdown');
    // Force the registry to still hold the stale reference (simulates the
    // racy window before the `worker.disposed` cleanup propagates).
    (registry as unknown as { workers: Map<string, ChannelWorker> }).workers.set('ch1', w1);
    const w2 = registry.getOrCreate('ch1', baseDeps(new IdleTurnDriver()));
    expect(w2).not.toBe(w1);
    expect(w2.inspect().lifecycle).not.toBe('shutdown');
    await w2.shutdown();
  });

  it('factory override is honored (tests / fakes)', () => {
    // Registry calls `worker.on('fatal', ...)` so the fake must satisfy
    // the EventEmitter surface we depend on.
    const fakeWorker = {
      on: () => fakeWorker,
      shutdown: async () => undefined,
    } as unknown as ChannelWorker;
    const registry = new ChannelWorkerRegistry({ factory: () => fakeWorker });
    const w = registry.getOrCreate('ch1', baseDeps(new IdleTurnDriver()));
    expect(w).toBe(fakeWorker);
  });

  it('emits worker.disposed before worker.created when replacing a stale worker', async () => {
    // Regression guard: the tracker's `bound.has(channelId)` check requires
    // `worker.disposed` to fire BEFORE `worker.created` for the replacement.
    // Otherwise the new worker has no tracker bound.
    const registry = new ChannelWorkerRegistry();
    const w1 = registry.getOrCreate('ch1', baseDeps(new IdleTurnDriver()));
    await w1.shutdown({ drain: false });
    // Force the stale ref to remain in the map (simulates the race window).
    (registry as unknown as { workers: Map<string, ChannelWorker> }).workers.set('ch1', w1);

    const events: string[] = [];
    registry.on('worker.disposed', () => events.push('disposed'));
    registry.on('worker.created', () => events.push('created'));

    const w2 = registry.getOrCreate('ch1', baseDeps(new IdleTurnDriver()));
    expect(events).toEqual(['disposed', 'created']);
    expect(w2).not.toBe(w1);
    await w2.shutdown();
  });
});
