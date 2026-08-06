import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { ChannelRunningTracker } from '../../src/services/channel-running-tracker';

/**
 * Fake worker — EventEmitter with `inspect()` returning lifecycle.
 * Tracker reads `lifecycle === 'idle'` before flipping setRunning(false).
 */
class FakeWorker extends EventEmitter {
  public lifecycle: 'idle' | 'running' | 'shutdown' = 'idle';
  inspect() {
    return { lifecycle: this.lifecycle };
  }
}

/** Fake registry — EventEmitter + `get(channelId)` lookup. */
class FakeRegistry extends EventEmitter {
  private workers = new Map<string, FakeWorker>();
  set(channelId: string, w: FakeWorker) {
    this.workers.set(channelId, w);
  }
  get(channelId: string) {
    return this.workers.get(channelId);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ChannelRunningTracker', () => {
  let registry: FakeRegistry;
  let setRunningMock: ReturnType<typeof mock>;
  let channelManager: { setRunning: typeof setRunningMock };
  let tracker: ChannelRunningTracker;

  beforeEach(() => {
    registry = new FakeRegistry();
    setRunningMock = mock(async () => undefined);
    channelManager = { setRunning: setRunningMock };
    // biome-ignore lint/suspicious/noExplicitAny: minimal mocks for unit isolation
    tracker = new ChannelRunningTracker(registry as any, channelManager as any);
  });

  afterEach(() => {
    tracker.__resetForTests();
  });

  it('item.started → setRunning(channelId, true) immediately', () => {
    const worker = new FakeWorker();
    registry.set('ch_1', worker);
    registry.emit('worker.created', 'ch_1', worker);

    worker.emit('item.started');

    expect(setRunningMock).toHaveBeenCalledWith('ch_1', true);
  });

  it('idle → setTimeout(250ms) → setRunning(false)', async () => {
    const worker = new FakeWorker();
    registry.set('ch_2', worker);
    registry.emit('worker.created', 'ch_2', worker);

    worker.lifecycle = 'idle';
    worker.emit('idle');
    expect(setRunningMock).not.toHaveBeenCalledWith('ch_2', false);

    await sleep(280);
    expect(setRunningMock).toHaveBeenCalledWith('ch_2', false);
  }, 500);

  it('idle followed by item.started before 250ms cancels debounce — setRunning(false) never called', async () => {
    const worker = new FakeWorker();
    registry.set('ch_3', worker);
    registry.emit('worker.created', 'ch_3', worker);

    worker.lifecycle = 'idle';
    worker.emit('idle');
    await sleep(100);
    worker.lifecycle = 'running';
    worker.emit('item.started');

    await sleep(280);
    const falseCalls = setRunningMock.mock.calls.filter((c) => c[1] === false);
    expect(falseCalls.length).toBe(0);
  }, 500);

  it('repeated item.started (re-start after aborted idle) is idempotent — setRunning(true) called per event', () => {
    const worker = new FakeWorker();
    registry.set('ch_4', worker);
    registry.emit('worker.created', 'ch_4', worker);

    worker.emit('item.started');
    worker.emit('idle');
    worker.emit('item.started');

    const trueCalls = setRunningMock.mock.calls.filter((c) => c[1] === true);
    expect(trueCalls.length).toBe(2);
  });

  it('bound Set prevents double wire — repeated worker.created with same channelId only wires once', () => {
    const worker = new FakeWorker();
    registry.set('ch_5', worker);

    registry.emit('worker.created', 'ch_5', worker);
    registry.emit('worker.created', 'ch_5', worker);

    worker.emit('item.started');
    // If wired twice, setRunning(true) would be called twice for one event.
    const trueCalls = setRunningMock.mock.calls.filter((c) => c[1] === true);
    expect(trueCalls.length).toBe(1);
  });
});
