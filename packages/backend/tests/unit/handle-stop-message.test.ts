/**
 * handleStopMessage tests (Phase 2.4 — TER-348).
 *
 * Verifies the WS `stop_message` routing on `MessageHandler.handleStopMessage`:
 * - soft  → worker.abort({ kind: 'soft' }), NO clearQueue
 * - hard  → worker.abort({ kind: 'hard' }), NO clearQueue (hard purges internally)
 * - queue_only → worker.clearQueue(), NO abort
 * - worker missing → idempotent no-op (no error sent)
 * - channel missing → sendError("CHANNEL_NOT_FOUND")
 * - canAccessChannel=false → sendError("UNAUTHORIZED")
 *
 * Schema validation kept in the parallel describe at the bottom of the file.
 *
 * Strategy: invoke `MessageHandler.prototype.handleStopMessage.call(stub, ...)`
 * with a minimal `this` carrying only what the method touches
 * (`channelManager.getChannel`, `channelManager.canAccessChannel`, `sendError`).
 * The singleton registry is replaced via `__setChannelWorkerRegistryForTests`
 * (no `mock.module` — would leak across test files in bun:test).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { StopMessageRequestSchema } from '@teros/shared';
import { MessageHandler } from '../../src/handlers/message-handler';
import {
  __resetChannelWorkerRegistryForTests,
  __setChannelWorkerRegistryForTests,
} from '../../src/services/channel-worker-host';

type FakeWorker = {
  abort: ReturnType<typeof mock>;
  clearQueue: ReturnType<typeof mock>;
};

const workersByChannel = new Map<string, FakeWorker>();

const fakeRegistry = {
  get: mock((channelId: string) => workersByChannel.get(channelId)),
  getOrCreate: mock(() => undefined as any),
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHANNEL_ID = 'ch_test_stop';
const USER_ID = 'user_stop_caller' as any;

function makeFakeWorker(): FakeWorker {
  return {
    abort: mock(async (_opts: { kind: 'soft' | 'hard'; reason?: string }) => {}),
    clearQueue: mock(() => 0),
  };
}

function makeFakeWs() {
  const send = mock((_data: string) => {});
  return {
    send,
    readyState: 1,
    OPEN: 1,
  } as any;
}

function makeStub(opts: {
  channel?: any;
  canAccess?: boolean;
}) {
  const getChannel = mock(async (_id: string) => opts.channel ?? null);
  const canAccessChannel = mock(async (_id: string, _userId: any) =>
    opts.canAccess ?? true,
  );
  const sendError = mock((_ws: any, _code: string, _message: string) => {});
  const stub = {
    channelManager: { getChannel, canAccessChannel },
    sendError,
  };
  return { stub, getChannel, canAccessChannel, sendError };
}

function callHandler(
  stub: any,
  ws: any,
  request: { type: 'stop_message'; channelId: string; kind: 'soft' | 'hard' | 'queue_only' },
) {
  return (MessageHandler.prototype as any).handleStopMessage.call(
    stub,
    ws,
    USER_ID,
    request,
  );
}

// ---------------------------------------------------------------------------
// Handler tests
// ---------------------------------------------------------------------------

describe('MessageHandler.handleStopMessage', () => {
  beforeEach(() => {
    workersByChannel.clear();
    fakeRegistry.get.mockClear();
    __setChannelWorkerRegistryForTests(fakeRegistry);
  });

  afterEach(() => {
    __resetChannelWorkerRegistryForTests();
  });

  afterAll(() => {
    __resetChannelWorkerRegistryForTests();
  });

  it('soft with active worker → abort({kind:"soft"}), no clearQueue', async () => {
    const worker = makeFakeWorker();
    workersByChannel.set(CHANNEL_ID, worker);
    const { stub, sendError } = makeStub({ channel: { id: CHANNEL_ID } });
    const ws = makeFakeWs();

    await callHandler(stub, ws, {
      type: 'stop_message',
      channelId: CHANNEL_ID,
      kind: 'soft',
    });

    expect(worker.abort).toHaveBeenCalledTimes(1);
    expect(worker.abort.mock.calls[0][0]).toEqual({ kind: 'soft' });
    expect(worker.clearQueue).toHaveBeenCalledTimes(0);
    expect(sendError).toHaveBeenCalledTimes(0);
    expect(ws.send).toHaveBeenCalledTimes(0);
  });

  it('hard with active worker → abort({kind:"hard"}), no clearQueue', async () => {
    const worker = makeFakeWorker();
    workersByChannel.set(CHANNEL_ID, worker);
    const { stub, sendError } = makeStub({ channel: { id: CHANNEL_ID } });
    const ws = makeFakeWs();

    await callHandler(stub, ws, {
      type: 'stop_message',
      channelId: CHANNEL_ID,
      kind: 'hard',
    });

    expect(worker.abort).toHaveBeenCalledTimes(1);
    expect(worker.abort.mock.calls[0][0]).toEqual({ kind: 'hard' });
    // hard already purges the queue inside abort() — handler must NOT call clearQueue too.
    expect(worker.clearQueue).toHaveBeenCalledTimes(0);
    expect(sendError).toHaveBeenCalledTimes(0);
  });

  it('queue_only with active worker → clearQueue(), no abort', async () => {
    const worker = makeFakeWorker();
    workersByChannel.set(CHANNEL_ID, worker);
    const { stub, sendError } = makeStub({ channel: { id: CHANNEL_ID } });
    const ws = makeFakeWs();

    await callHandler(stub, ws, {
      type: 'stop_message',
      channelId: CHANNEL_ID,
      kind: 'queue_only',
    });

    expect(worker.clearQueue).toHaveBeenCalledTimes(1);
    expect(worker.abort).toHaveBeenCalledTimes(0);
    expect(sendError).toHaveBeenCalledTimes(0);
  });

  it('no worker in registry → idempotent no-op (no abort, no clearQueue, no error)', async () => {
    // workersByChannel intentionally empty
    const { stub, sendError } = makeStub({ channel: { id: CHANNEL_ID } });
    const ws = makeFakeWs();

    await callHandler(stub, ws, {
      type: 'stop_message',
      channelId: CHANNEL_ID,
      kind: 'soft',
    });

    expect(fakeRegistry.get).toHaveBeenCalledTimes(1);
    expect(fakeRegistry.get.mock.calls[0][0]).toBe(CHANNEL_ID);
    expect(sendError).toHaveBeenCalledTimes(0);
    expect(ws.send).toHaveBeenCalledTimes(0);
  });

  it('queue_only with no worker → idempotent no-op', async () => {
    const { stub, sendError } = makeStub({ channel: { id: CHANNEL_ID } });
    const ws = makeFakeWs();

    await callHandler(stub, ws, {
      type: 'stop_message',
      channelId: CHANNEL_ID,
      kind: 'queue_only',
    });

    expect(sendError).toHaveBeenCalledTimes(0);
    expect(ws.send).toHaveBeenCalledTimes(0);
  });

  it('channel not found → sendError("CHANNEL_NOT_FOUND"), no registry lookup', async () => {
    const worker = makeFakeWorker();
    workersByChannel.set(CHANNEL_ID, worker);
    const { stub, sendError } = makeStub({ channel: null });
    const ws = makeFakeWs();

    await callHandler(stub, ws, {
      type: 'stop_message',
      channelId: CHANNEL_ID,
      kind: 'soft',
    });

    expect(sendError).toHaveBeenCalledTimes(1);
    expect(sendError.mock.calls[0][1]).toBe('CHANNEL_NOT_FOUND');
    // Must short-circuit before touching the worker registry.
    expect(fakeRegistry.get).toHaveBeenCalledTimes(0);
    expect(worker.abort).toHaveBeenCalledTimes(0);
    expect(worker.clearQueue).toHaveBeenCalledTimes(0);
  });

  it('canAccessChannel=false → sendError("UNAUTHORIZED"), no registry lookup', async () => {
    const worker = makeFakeWorker();
    workersByChannel.set(CHANNEL_ID, worker);
    const { stub, sendError } = makeStub({
      channel: { id: CHANNEL_ID },
      canAccess: false,
    });
    const ws = makeFakeWs();

    await callHandler(stub, ws, {
      type: 'stop_message',
      channelId: CHANNEL_ID,
      kind: 'hard',
    });

    expect(sendError).toHaveBeenCalledTimes(1);
    expect(sendError.mock.calls[0][1]).toBe('UNAUTHORIZED');
    expect(fakeRegistry.get).toHaveBeenCalledTimes(0);
    expect(worker.abort).toHaveBeenCalledTimes(0);
    expect(worker.clearQueue).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Schema validation (kept from the previous file)
// ---------------------------------------------------------------------------

describe('StopMessageRequestSchema validation', () => {
  it('accepts kind=soft (default)', () => {
    const parsed = StopMessageRequestSchema.parse({
      type: 'stop_message',
      channelId: 'ch_test',
    });
    expect(parsed.kind).toBe('soft');
  });

  it('accepts kind=hard', () => {
    const parsed = StopMessageRequestSchema.parse({
      type: 'stop_message',
      channelId: 'ch_test',
      kind: 'hard',
    });
    expect(parsed.kind).toBe('hard');
  });

  it('accepts kind=queue_only', () => {
    const parsed = StopMessageRequestSchema.parse({
      type: 'stop_message',
      channelId: 'ch_test',
      kind: 'queue_only',
    });
    expect(parsed.kind).toBe('queue_only');
  });

  it('rejects unknown kind values', () => {
    expect(() =>
      StopMessageRequestSchema.parse({
        type: 'stop_message',
        channelId: 'ch_test',
        kind: 'nuclear',
      }),
    ).toThrow();
  });

  it('rejects missing channelId', () => {
    expect(() =>
      StopMessageRequestSchema.parse({
        type: 'stop_message',
      }),
    ).toThrow();
  });

  it('rejects wrong type literal', () => {
    expect(() =>
      StopMessageRequestSchema.parse({
        type: 'send_message',
        channelId: 'ch_test',
      }),
    ).toThrow();
  });
});
