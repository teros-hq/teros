/**
 * ResumeService unit tests — post-crash recovery is system_resume-only:
 * sweepStaleQueueState + clearRunningFlag + reconcileOrphansAcross + the
 * recoverable-channel dispatch path. Boot-time replay of queued user
 * messages was removed (2026-08-14 incident: every restart re-drove the
 * channel's stale backlog).
 *
 * Mongo is stubbed via a fake per-collection `Db`; SessionStore is mocked
 * with the InMemorySessionStore-shaped methods the service touches.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { SessionStore } from '@teros/core';
import { ResumeService } from '../../src/services/resume-service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHANNEL = 'ch_recover_1';

type MockCollection = {
  updateOne: ReturnType<typeof mock>;
  updateMany: ReturnType<typeof mock>;
  findOne: ReturnType<typeof mock>;
  find: ReturnType<typeof mock>;
};

function makeMockDb() {
  const collections = new Map<string, MockCollection>();
  const col = (name: string): MockCollection => {
    let c = collections.get(name);
    if (!c) {
      c = {
        updateOne: mock(async () => ({ matchedCount: 1, modifiedCount: 1 })),
        updateMany: mock(async () => ({ matchedCount: 0, modifiedCount: 0 })),
        findOne: mock(async () => null),
        find: mock(() => ({ toArray: async () => [] as any[] })),
      };
      collections.set(name, c);
    }
    return c;
  };
  const db = { collection: (name: string) => col(name) } as any;
  return { db, col };
}

function makeService(
  db: any,
  sessionStore: SessionStore | null = null,
): { svc: ResumeService; handleScheduledEvent: ReturnType<typeof mock> } {
  const handleScheduledEvent = mock(async () => ({ success: true }));
  const eventHandler = { handleScheduledEvent } as any;
  const channelManager = { setRunning: mock(async () => {}) } as any;
  return {
    svc: new ResumeService(db, eventHandler, channelManager, null, sessionStore),
    handleScheduledEvent,
  };
}

// ---------------------------------------------------------------------------
// sweepStaleQueueState
// ---------------------------------------------------------------------------

describe('ResumeService.sweepStaleQueueState', () => {
  it('marks pre-boot pending/running user messages as done, time-guarded by bootTimeMs', async () => {
    const { db, col } = makeMockDb();
    const before = Date.now();
    const { svc } = makeService(db, null);
    const after = Date.now();

    await (svc as any).sweepStaleQueueState();

    const sessionMessages = col('session_messages');
    expect(sessionMessages.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = sessionMessages.updateMany.mock.calls[0] as any[];
    expect(filter['info.role']).toBe('user');
    expect(filter['info.meta.queueState']).toEqual({ $in: ['pending', 'running'] });
    // The time guard must be the construction instant — live messages that
    // arrive after boot are excluded.
    const cutoff = filter['info.time.created'].$lt;
    expect(cutoff).toBeGreaterThanOrEqual(before);
    expect(cutoff).toBeLessThanOrEqual(after);
    expect(update).toEqual({ $set: { 'info.meta.queueState': 'done' } });
  });

  it('runs even when no channels are running (backlog hygiene on every boot)', async () => {
    const { db, col } = makeMockDb();
    const { svc } = makeService(db, null);

    await svc.checkAndResumeConversations();

    expect(col('session_messages').updateMany).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// checkAndResumeConversations — dispatch
// ---------------------------------------------------------------------------

describe('ResumeService.checkAndResumeConversations', () => {
  it('zombie channel (stale runningAt) is reset and never resumed', async () => {
    const { db, col } = makeMockDb();
    const channels = col('channels');
    channels.find = mock(() => ({
      toArray: async () => [
        {
          channelId: CHANNEL,
          running: true,
          runningAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
      ],
    }));
    const { svc, handleScheduledEvent } = makeService(db, null);

    await svc.checkAndResumeConversations();

    expect(handleScheduledEvent).toHaveBeenCalledTimes(0);
    const resetCall = channels.updateOne.mock.calls.find(
      (c: any[]) => c[0].channelId === CHANNEL && c[1].$set?.running === false,
    );
    expect(resetCall).toBeDefined();
  });

  it('recoverable normal channel gets exactly one system_resume — no message replay', async () => {
    const { db, col } = makeMockDb();
    const channels = col('channels');
    channels.find = mock(() => ({
      toArray: async () => [
        { channelId: CHANNEL, running: true, runningAt: new Date().toISOString() },
      ],
    }));
    // Revalidation inside triggerResumeEvent: still running.
    channels.findOne = mock(async () => ({ running: true }));
    // No linked board task → normal channel path.
    col('tasks').findOne = mock(async () => null);
    const { svc, handleScheduledEvent } = makeService(db, null);

    await svc.checkAndResumeConversations();

    expect(handleScheduledEvent).toHaveBeenCalledTimes(1);
    const [event] = handleScheduledEvent.mock.calls[0] as any[];
    expect(event.channelId).toBe(CHANNEL);
    expect(event.eventType).toBe('system_resume');
    expect(event.wakeUpAgent).toBe(true);
  });

  it('recoverable channel whose agent already finished (running=false on revalidate) is skipped', async () => {
    const { db, col } = makeMockDb();
    const channels = col('channels');
    channels.find = mock(() => ({
      toArray: async () => [
        { channelId: CHANNEL, running: true, runningAt: new Date().toISOString() },
      ],
    }));
    channels.findOne = mock(async () => ({ running: false }));
    col('tasks').findOne = mock(async () => null);
    const { svc, handleScheduledEvent } = makeService(db, null);

    await svc.checkAndResumeConversations();

    expect(handleScheduledEvent).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// clearRunningFlag
// ---------------------------------------------------------------------------

describe('ResumeService.clearRunningFlag', () => {
  it('issues updateOne({running:false}, $unset runningAt) on channels collection', async () => {
    const { db, col } = makeMockDb();
    const { svc } = makeService(db, null);

    await (svc as any).clearRunningFlag(CHANNEL);

    const channels = col('channels');
    expect(channels.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = channels.updateOne.mock.calls[0] as any[];
    expect(filter).toEqual({ channelId: CHANNEL });
    expect(update.$set).toEqual({ running: false });
    expect(update.$unset).toEqual({ runningAt: '' });
  });
});

// ---------------------------------------------------------------------------
// reconcileOrphansAcross
// ---------------------------------------------------------------------------

describe('ResumeService.reconcileOrphansAcross', () => {
  it('returns channelIds unchanged if SessionStore is null (skips reconcile)', async () => {
    const { db } = makeMockDb();
    const { svc } = makeService(db, null);

    const result = await (svc as any).reconcileOrphansAcross(['ch_1', 'ch_2']);
    expect(result).toEqual(['ch_1', 'ch_2']);
  });

  it('synthesizes orphan tool_result and keeps the channel in the recovered list (INV-1)', async () => {
    // assertInvariantINV1 throws in dev mode when orphans exist — production mode
    // lets reconcileChannel run synthesize + verify on its own.
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const { db } = makeMockDb();
    // Stub a store with one orphan tool_use → reconcileChannel writes a synthetic
    // tool_result. After re-read, INV-1 must hold.
    const initialMessages: any[] = [
      {
        info: { id: 'msg_1', sessionID: CHANNEL, role: 'assistant', time: { created: 1 } },
        parts: [
          {
            id: 'part_orphan',
            sessionID: CHANNEL,
            messageID: 'msg_1',
            type: 'tool',
            tool: 'test-tool',
            callID: 'call_orphan',
            state: { status: 'running', input: {}, time: { start: 1 } },
          },
        ],
      },
    ];
    const currentMessages = JSON.parse(JSON.stringify(initialMessages));
    const writePart = mock(async (part: any) => {
      // Replace orphan part with the synthesized error tool_result so the
      // re-verify pass in reconcileChannel sees INV-1 closed.
      for (const msg of currentMessages) {
        const idx = msg.parts.findIndex(
          (p: any) => p.type === 'tool' && p.callID === part.callID,
        );
        if (idx >= 0) msg.parts[idx] = part;
      }
    });
    const store = {
      getMessagesForLLM: async () => ({ messages: currentMessages }),
      writePart,
      listPendingQueueMessages: async () => [],
      updateUserMessageQueueState: async () => {},
    } as unknown as SessionStore;

    const { svc } = makeService(db, store);
    try {
      const result = await (svc as any).reconcileOrphansAcross([CHANNEL]);

      expect(result).toEqual([CHANNEL]);
      // synthesizeOrphans wrote at least one synthetic tool_result.
      expect(writePart).toHaveBeenCalled();
      const written = writePart.mock.calls[0][0] as any;
      expect(written.callID).toBe('call_orphan');
      expect(written.state.status).toBe('error');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });
});


// ---------------------------------------------------------------------------
// resetTaskRunningForChannel — zombie task running flag cleanup
// ---------------------------------------------------------------------------

describe('ResumeService.resetTaskRunningForChannel', () => {
  it('resets running=false on tasks linked to the channel that have running=true', async () => {
    const { db, col } = makeMockDb();
    const tasks = col('tasks');
    tasks.updateMany = mock(async () => ({ matchedCount: 1, modifiedCount: 1 }));
    const { svc } = makeService(db, null);

    await (svc as any).resetTaskRunningForChannel(CHANNEL);

    expect(tasks.updateMany).toHaveBeenCalledTimes(1);
    const [filter, update] = tasks.updateMany.mock.calls[0] as any[];
    expect(filter).toEqual({ channelId: CHANNEL, running: true });
    expect(update.$set.running).toBe(false);
    expect(update.$set.updatedAt).toBeDefined();
    expect(update.$push.activity).toBeDefined();
  });

  it('does not throw when no tasks match (graceful no-op)', async () => {
    const { db, col } = makeMockDb();
    const tasks = col('tasks');
    tasks.updateMany = mock(async () => ({ matchedCount: 0, modifiedCount: 0 }));
    const { svc } = makeService(db, null);

    // Should not throw
    await expect((svc as any).resetTaskRunningForChannel(CHANNEL)).resolves.toBeUndefined();
  });

  it('logs modifiedCount when tasks are reset', async () => {
    const { db, col } = makeMockDb();
    const tasks = col('tasks');
    tasks.updateMany = mock(async () => ({ matchedCount: 2, modifiedCount: 2 }));
    const origLog = console.log;
    let logged = false;
    console.log = (...args: any[]) => { if (args[0]?.includes?.('Reset running=false')) logged = true; origLog(...args); };
    const { svc } = makeService(db, null);

    await (svc as any).resetTaskRunningForChannel(CHANNEL);

    console.log = origLog;
    // The updateMany was called (the log is best-effort, we just verify the call happened)
    expect(tasks.updateMany).toHaveBeenCalledTimes(1);
    expect(logged).toBe(true);
  });
});

describe('ResumeService.checkAndResumeConversations — zombie task cleanup', () => {
  it('resets task.running=false when resetting zombie channels', async () => {
    const { db, col } = makeMockDb();
    const channels = col('channels');
    channels.find = mock(() => ({
      toArray: async () => [
        {
          channelId: CHANNEL,
          running: true,
          runningAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // zombie (old)
        },
      ],
    }));
    const tasks = col('tasks');
    tasks.updateMany = mock(async () => ({ matchedCount: 1, modifiedCount: 1 }));
    const { svc } = makeService(db, null);

    await svc.checkAndResumeConversations();

    // Channel running flag reset
    const channelReset = channels.updateOne.mock.calls.find(
      (c: any[]) => c[0].channelId === CHANNEL && c[1].$set?.running === false,
    );
    expect(channelReset).toBeDefined();

    // Task running flag also reset
    const taskReset = tasks.updateMany.mock.calls.find(
      (c: any[]) => c[0].channelId === CHANNEL && c[0].running === true && c[1].$set?.running === false,
    );
    expect(taskReset).toBeDefined();
  });
});

describe('ResumeService.clearRunningFlag — task cleanup', () => {
  it('also resets task.running=false when clearing channel running flag', async () => {
    const { db, col } = makeMockDb();
    const tasks = col('tasks');
    tasks.updateMany = mock(async () => ({ matchedCount: 1, modifiedCount: 1 }));
    const { svc } = makeService(db, null);

    await (svc as any).clearRunningFlag(CHANNEL);

    // Channel reset
    const channels = col('channels');
    expect(channels.updateOne).toHaveBeenCalledTimes(1);
    const [chFilter, chUpdate] = channels.updateOne.mock.calls[0] as any[];
    expect(chFilter).toEqual({ channelId: CHANNEL });
    expect(chUpdate.$set).toEqual({ running: false });

    // Task reset
    expect(tasks.updateMany).toHaveBeenCalledTimes(1);
    const [taskFilter, taskUpdate] = tasks.updateMany.mock.calls[0] as any[];
    expect(taskFilter).toEqual({ channelId: CHANNEL, running: true });
    expect(taskUpdate.$set.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DEP-REQ-6 — the boot sweep waits until this is the only live instance
// ---------------------------------------------------------------------------
describe('ResumeService.startWithDelay (blue/green handoff, DEP)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it('[DEP-AC-8] does not scan channels until the instance registry says we are alone', async () => {
    const { db, col } = makeMockDb();
    const channels = col('channels');
    let release!: () => void;
    const alone = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const registry = { waitUntilSoleInstance: mock(() => alone) } as any;
    const eventHandler = { handleScheduledEvent: mock(async () => ({ success: true })) } as any;
    const channelManager = { setRunning: mock(async () => {}) } as any;

    await ResumeService.startWithDelay(db, eventHandler, channelManager, null, null, registry, 0);
    await tick();
    expect(registry.waitUntilSoleInstance).toHaveBeenCalledWith({ pollMs: 2000, timeoutMs: 10 * 60 * 1000 });
    expect(channels.find).not.toHaveBeenCalled(); // still waiting: the other color is alive

    release();
    await tick();
    expect(channels.find).toHaveBeenCalled(); // alone now → sweep
  });

  it('[DEP-AC-8] sweeps right away without a registry (single-instance boot)', async () => {
    const { db, col } = makeMockDb();
    const eventHandler = { handleScheduledEvent: mock(async () => ({ success: true })) } as any;
    const channelManager = { setRunning: mock(async () => {}) } as any;
    await ResumeService.startWithDelay(db, eventHandler, channelManager, null, null, null, 0);
    await tick();
    expect(col('channels').find).toHaveBeenCalled();
  });
});
