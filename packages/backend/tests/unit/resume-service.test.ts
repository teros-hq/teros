/**
 * ResumeService unit tests — covers post-crash recovery additions:
 * replayPendingQueuedMessages + clearRunningFlag + reconcileOrphansAcross.
 *
 * Mongo is stubbed via a fake `Db.collection().updateOne()`; SessionStore
 * is mocked with the InMemorySessionStore-shaped methods the service touches.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { MessageWithParts, SessionStore } from '@teros/core';
import { ResumeService } from '../../src/services/resume-service';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHANNEL = 'ch_recover_1';

function mkUserMsg(id: string, text: string, channelId = CHANNEL): MessageWithParts {
  return {
    info: {
      id,
      sessionID: channelId,
      role: 'user',
      time: { created: Date.now() },
      meta: { queueState: 'pending' },
    } as any,
    parts: [
      {
        id: `part_${id}`,
        sessionID: channelId,
        messageID: id,
        type: 'text',
        text,
      } as any,
    ],
  };
}

function mkFileOnlyMsg(
  id: string,
  channelId = CHANNEL,
  opts: { filename?: string; mime?: string; url?: string } = {},
): MessageWithParts {
  return {
    info: {
      id,
      sessionID: channelId,
      role: 'user',
      time: { created: Date.now() },
      meta: { queueState: 'pending' },
    } as any,
    parts: [
      {
        id: `part_${id}`,
        sessionID: channelId,
        messageID: id,
        type: 'file',
        filename: opts.filename ?? 'attachment.png',
        mime: opts.mime ?? 'image/png',
        url: opts.url ?? 'data:image/png;base64,iVBOR',
      } as any,
    ],
  };
}

function makeMockDb() {
  const updateOne = mock(async () => ({ matchedCount: 1, modifiedCount: 1 }));
  const findOne = mock(async () => null);
  const find = mock(() => ({ toArray: async () => [] as any[] }));
  const db = {
    collection: () => ({ updateOne, findOne, find }),
  } as any;
  return { db, updateOne, findOne };
}

function makeMockSessionStore(opts: {
  pending?: MessageWithParts[];
  reconcile?: (channelId: string) => Promise<{ orphanedToolCount: number; recovered: boolean }>;
}) {
  const updateUserMessageQueueState = mock(async (_id: string, _state: string) => {});
  const listPendingQueueMessages = mock(async (_channels: string[]) => opts.pending ?? []);
  const store = {
    listPendingQueueMessages,
    updateUserMessageQueueState,
    // reconcileChannel reads getMessagesForLLM — we surface a no-orphan stub by default.
    getMessagesForLLM: async (_id: string) => ({ messages: [] as any[] }),
    writePart: async () => {},
  } as unknown as SessionStore;
  return { store, updateUserMessageQueueState, listPendingQueueMessages };
}

function makeService(
  db: any,
  sessionStore: SessionStore | null = null,
): ResumeService {
  const eventHandler = { handleScheduledEvent: mock(async () => ({ success: true })) } as any;
  const channelManager = { setRunning: mock(async () => {}) } as any;
  return new ResumeService(db, eventHandler, channelManager, null, sessionStore);
}

// ---------------------------------------------------------------------------
// replayPendingQueuedMessages
// ---------------------------------------------------------------------------

describe('ResumeService.replayPendingQueuedMessages', () => {
  it('empty queue: no replay callback fired; clearRunningFlag is called per channel', async () => {
    const { db, updateOne } = makeMockDb();
    const { store, listPendingQueueMessages } = makeMockSessionStore({ pending: [] });
    const replay = mock(async (_c: string, _m: string, _t: string, _p: any[]) => {});
    const svc = makeService(db, store);
    svc.setQueueReplayHook(replay);

    await (svc as any).replayPendingQueuedMessages([CHANNEL]);

    expect(listPendingQueueMessages).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledTimes(0);
    // No pending → clear flag so running=true doesn't stay stuck.
    expect(updateOne).toHaveBeenCalledTimes(1);
  });

  it('N pending messages: replay callback called N times, FIFO order per channel', async () => {
    const { db } = makeMockDb();
    const pending = [
      mkUserMsg('msg_a', 'first'),
      mkUserMsg('msg_b', 'second'),
      mkUserMsg('msg_c', 'third'),
    ];
    const { store } = makeMockSessionStore({ pending });
    const order: string[] = [];
    const replay = mock(async (_c: string, id: string, _t: string, _p: any[]) => {
      order.push(id);
    });
    const svc = makeService(db, store);
    svc.setQueueReplayHook(replay);

    await (svc as any).replayPendingQueuedMessages([CHANNEL]);

    expect(replay).toHaveBeenCalledTimes(3);
    // All on the same channel → must remain FIFO inside the channel.
    expect(order).toEqual(['msg_a', 'msg_b', 'msg_c']);
  });

  it('error in replay does not block subsequent messages; failed msg marked done', async () => {
    const { db } = makeMockDb();
    const pending = [
      mkUserMsg('msg_a', 'good'),
      mkUserMsg('msg_b', 'boom'),
      mkUserMsg('msg_c', 'good_again'),
    ];
    const { store, updateUserMessageQueueState } = makeMockSessionStore({ pending });
    const replay = mock(async (_c: string, id: string, _t: string, _p: any[]) => {
      if (id === 'msg_b') throw new Error('downstream replay failed');
    });
    const svc = makeService(db, store);
    svc.setQueueReplayHook(replay);

    await (svc as any).replayPendingQueuedMessages([CHANNEL]);

    expect(replay).toHaveBeenCalledTimes(3);
    // The failed one should have been marked 'done' to avoid re-trying forever.
    const calls = updateUserMessageQueueState.mock.calls;
    const doneCalls = calls.filter((c: any[]) => c[0] === 'msg_b' && c[1] === 'done');
    expect(doneCalls.length).toBe(1);
  });

  it('message with only file parts is replayed (NOT auto-marked done) and parts are forwarded', async () => {
    const { db } = makeMockDb();
    const pending = [mkFileOnlyMsg('msg_file', CHANNEL, { filename: 'cat.png', mime: 'image/png' })];
    const { store, updateUserMessageQueueState } = makeMockSessionStore({ pending });
    const replay = mock(async (_c: string, _id: string, _t: string, _p: any[]) => {});
    const svc = makeService(db, store);
    svc.setQueueReplayHook(replay);

    await (svc as any).replayPendingQueuedMessages([CHANNEL]);

    // File-only message MUST hit the replay path (not be silently marked done).
    expect(replay).toHaveBeenCalledTimes(1);
    const [, msgId, text, parts] = replay.mock.calls[0] as any[];
    expect(msgId).toBe('msg_file');
    expect(text).toBe('');
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('file');
    expect(parts[0].filename).toBe('cat.png');

    // No premature `done` for the file-only message — only the post-replay
    // state machine should advance it.
    const prematureDone = updateUserMessageQueueState.mock.calls.find(
      (c: any[]) => c[0] === 'msg_file' && c[1] === 'done',
    );
    expect(prematureDone).toBeUndefined();
  });

  it('message with NO text and NO file parts (truly empty) IS auto-marked done', async () => {
    const { db } = makeMockDb();
    const emptyMsg: MessageWithParts = {
      info: {
        id: 'msg_empty',
        sessionID: CHANNEL,
        role: 'user',
        time: { created: Date.now() },
        meta: { queueState: 'pending' },
      } as any,
      parts: [], // no parts at all
    };
    const { store, updateUserMessageQueueState } = makeMockSessionStore({ pending: [emptyMsg] });
    const replay = mock(async () => {});
    const svc = makeService(db, store);
    svc.setQueueReplayHook(replay);

    await (svc as any).replayPendingQueuedMessages([CHANNEL]);

    expect(replay).toHaveBeenCalledTimes(0);
    const doneCall = updateUserMessageQueueState.mock.calls.find(
      (c: any[]) => c[0] === 'msg_empty' && c[1] === 'done',
    );
    expect(doneCall).toBeDefined();
  });

  it('multi-channel pending: messages from different channels can replay in parallel; per-channel FIFO preserved', async () => {
    const { db } = makeMockDb();
    const CH_A = 'ch_a';
    const CH_B = 'ch_b';
    // Two channels each with their own ordered messages.
    const pending = [
      mkUserMsg('a_1', '1', CH_A),
      mkUserMsg('b_1', '1', CH_B),
      mkUserMsg('a_2', '2', CH_A),
      mkUserMsg('b_2', '2', CH_B),
    ];
    const { store } = makeMockSessionStore({ pending });
    const channelOrder = new Map<string, string[]>();
    const replay = mock(async (cid: string, id: string) => {
      const list = channelOrder.get(cid) ?? [];
      list.push(id);
      channelOrder.set(cid, list);
    });
    const svc = makeService(db, store);
    svc.setQueueReplayHook(replay);

    await (svc as any).replayPendingQueuedMessages([CH_A, CH_B]);

    expect(replay).toHaveBeenCalledTimes(4);
    // Per-channel FIFO must hold (a_1 before a_2, b_1 before b_2).
    expect(channelOrder.get(CH_A)).toEqual(['a_1', 'a_2']);
    expect(channelOrder.get(CH_B)).toEqual(['b_1', 'b_2']);
  });

  it('no replay hook + pending messages → marks all as done (manual replay path)', async () => {
    const { db } = makeMockDb();
    const pending = [mkUserMsg('msg_a', 'x'), mkUserMsg('msg_b', 'y')];
    const { store, updateUserMessageQueueState } = makeMockSessionStore({ pending });
    const svc = makeService(db, store);
    // intentionally NOT calling setQueueReplayHook

    await (svc as any).replayPendingQueuedMessages([CHANNEL]);

    expect(updateUserMessageQueueState).toHaveBeenCalledTimes(2);
    for (const call of updateUserMessageQueueState.mock.calls) {
      expect(call[1]).toBe('done');
    }
  });
});

// ---------------------------------------------------------------------------
// clearRunningFlag
// ---------------------------------------------------------------------------

describe('ResumeService.clearRunningFlag', () => {
  it('issues updateOne({running:false}, $unset runningAt) on channels collection', async () => {
    const { db, updateOne } = makeMockDb();
    const svc = makeService(db, null);

    await (svc as any).clearRunningFlag(CHANNEL);

    expect(updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = updateOne.mock.calls[0] as any[];
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
    const svc = makeService(db, null);

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
    let currentMessages = JSON.parse(JSON.stringify(initialMessages));
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

    const svc = makeService(db, store);
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
