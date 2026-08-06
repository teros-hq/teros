/**
 * TurnReconciler tests (Phase 2.5 — TER-348).
 *
 * Verifies crash recovery synthesizes orphan tool_use parts and the
 * channel becomes INV-1 clean after reconcile.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { MessageWithParts, Part, ToolPart } from '../session/types';
import type { SessionStore } from '../session/SessionStore';
import { reconcileChannel } from './TurnReconciler';

const NODE_ENV_ORIG = process.env.NODE_ENV;

describe('reconcileChannel', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });
  afterEach(() => {
    process.env.NODE_ENV = NODE_ENV_ORIG;
  });

  it('no-op when channel has no orphans', async () => {
    const store = mockStore([
      mkMsg('msg_1', 'user', []),
      mkMsg('msg_2', 'assistant', [mkTool('call_1', 'completed')]),
    ]);
    const result = await reconcileChannel(store as unknown as SessionStore, 'ch_1');
    expect(result.recovered).toBe(true);
    expect(result.orphanedToolCount).toBe(0);
    expect(store.writes).toBe(0);
  });

  it('synthesizes orphan tool_use after crash', async () => {
    const store = mockStore([
      mkMsg('msg_1', 'assistant', [mkTool('call_orphan', 'running')]),
    ]);
    const result = await reconcileChannel(store as unknown as SessionStore, 'ch_1');
    expect(result.orphanedToolCount).toBe(1);
    expect(result.recovered).toBe(true);
    expect(store.writes).toBe(1);
    const written = store.writePartCalls[0] as ToolPart;
    expect(written.callID).toBe('call_orphan');
    expect(written.state.status).toBe('error');
  });

  it('synthesizes multiple orphans across messages', async () => {
    const store = mockStore([
      mkMsg('msg_1', 'assistant', [
        mkTool('call_a', 'completed'),
        mkTool('call_b', 'running'),
      ]),
      mkMsg('msg_2', 'assistant', [mkTool('call_c', 'pending_approval')]),
    ]);
    const result = await reconcileChannel(store as unknown as SessionStore, 'ch_1');
    expect(result.orphanedToolCount).toBe(2);
    expect(result.recovered).toBe(true);
    expect(store.writes).toBe(2);
  });

  it('returns recovered=false if synthesize fails permanently', async () => {
    const store = mockStore(
      [mkMsg('msg_1', 'assistant', [mkTool('call_stuck', 'running')])],
      { failAlways: true },
    );
    let thrown: unknown;
    try {
      await reconcileChannel(store as unknown as SessionStore, 'ch_1');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/INV-1 recovery failed/);
  }, 15000);
});

// ============================================================================
// Mock SessionStore
// ============================================================================

interface MockStore {
  writePartCalls: Part[];
  writes: number;
  getMessagesForLLM: (channelId: string) => Promise<{
    summary?: string;
    messages: MessageWithParts[];
  }>;
  writePart: (part: Part) => Promise<void>;
}

function mockStore(
  initial: MessageWithParts[],
  opts?: { failAlways?: boolean },
): MockStore {
  // Working copy of messages — mutations via writePart go here so the
  // re-verification step in reconcileChannel sees the synthesized results.
  let messages = JSON.parse(JSON.stringify(initial)) as MessageWithParts[];
  const writePartCalls: Part[] = [];

  return {
    writePartCalls,
    get writes(): number {
      return writePartCalls.length;
    },
    getMessagesForLLM: async () => ({ messages }),
    writePart: async (part: Part) => {
      writePartCalls.push(part);
      if (opts?.failAlways) {
        throw new Error('persistent-failure');
      }
      // Apply the write to the working messages so the verify step sees
      // the synthetic tool_result.
      if ((part as ToolPart).type === 'tool') {
        const target = part as ToolPart;
        for (const msg of messages) {
          const idx = msg.parts.findIndex(
            (p) => p.type === 'tool' && (p as ToolPart).callID === target.callID,
          );
          if (idx >= 0) {
            msg.parts[idx] = target;
            break;
          }
        }
      }
    },
  };
}

function mkMsg(id: string, role: 'user' | 'assistant', parts: any[]): MessageWithParts {
  return {
    info: {
      id,
      sessionID: 'ch_test',
      role,
      time: { created: Date.now() },
    } as any,
    parts,
  };
}

function mkTool(
  callID: string,
  status: 'running' | 'pending_approval' | 'completed' | 'error',
): ToolPart {
  const base: any = {
    id: `part_${callID}`,
    sessionID: 'ch_test',
    messageID: 'msg_test',
    type: 'tool',
    tool: 'test-tool',
    callID,
  };
  const time = { start: 100, end: status === 'running' || status === 'pending_approval' ? undefined : 200 };
  if (status === 'running') {
    base.state = { status: 'running', input: {}, time };
  } else if (status === 'pending_approval') {
    base.state = { status: 'pending_approval', input: {}, time };
  } else if (status === 'completed') {
    base.state = {
      status: 'completed',
      input: {},
      output: 'ok',
      title: '',
      metadata: {},
      time,
    };
  } else {
    base.state = { status: 'error', input: {}, error: 'failed', time };
  }
  return base as ToolPart;
}
