/**
 * synthesizeOrphans tests (Phase 2.2 — TER-348).
 *
 * Verifies idempotent retry semantics + persistence of synthetic tool_results.
 */

import { describe, expect, it } from 'bun:test';
import type { INV1Violation } from '../prompts/PromptBuilder';
import type { SessionStore } from '../session/SessionStore';
import type { Part, ToolPart } from '../session/types';
import { synthesizeOrphans } from './MessageProcessor';

describe('synthesizeOrphans', () => {
  it('no-op when violations list is empty', async () => {
    const store = mockStore();
    await synthesizeOrphans(store as unknown as SessionStore, 'session_x', []);
    expect(store.writePartCalls.length).toBe(0);
  });

  it('persists one synthetic per violation, status=error', async () => {
    const store = mockStore();
    const v: INV1Violation = mkViolation('call_1', 'orphan_running', { start: 100 });
    await synthesizeOrphans(store as unknown as SessionStore, 'session_x', [v]);
    expect(store.writePartCalls.length).toBe(1);
    const written = store.writePartCalls[0] as ToolPart;
    expect(written.callID).toBe('call_1');
    expect(written.state.status).toBe('error');
    const stateWithTime = written.state as { time?: { end?: number }; error?: string };
    expect(stateWithTime.time?.end).toBeGreaterThan(0);
    expect(stateWithTime.error).toContain('did not complete');
    expect((written as any).meta?.synthetic).toBe(true);
    expect((written as any).meta?.syntheticReason).toBe('inv1_recovery');
  });

  it('uses the pending_approval message when reason is orphan_pending_approval', async () => {
    const store = mockStore();
    const v: INV1Violation = mkViolation('call_2', 'orphan_pending_approval', { start: 200 });
    await synthesizeOrphans(store as unknown as SessionStore, 'session_x', [v]);
    const written = store.writePartCalls[0] as ToolPart;
    const stateWithErr = written.state as { error?: string };
    expect(stateWithErr.error).toContain('cancelled before approval');
  });

  it('retries on transient writePart failure (up to 3 attempts)', async () => {
    const store = mockStore({ failFirstN: 2 });
    const v: INV1Violation = mkViolation('call_3', 'orphan_running', { start: 100 });
    await synthesizeOrphans(store as unknown as SessionStore, 'session_x', [v]);
    expect(store.writePartCalls.length).toBe(3);  // 2 failures + 1 success
  });

  it('throws after 3 exhausted attempts', async () => {
    const store = mockStore({ failAlways: true });
    const v: INV1Violation = mkViolation('call_4', 'orphan_running', { start: 100 });
    let thrown: unknown;
    try {
      await synthesizeOrphans(store as unknown as SessionStore, 'session_x', [v]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('INV-1 recovery failed after 3 attempts');
    expect(store.writePartCalls.length).toBe(3);
  }, 15000);  // allow time for retries (500 + 1500 + ... backoffs)

  it('a transient failure on one violation does NOT block others', async () => {
    // First violation fails twice then succeeds; second succeeds first try.
    let writes = 0;
    const failingIds = new Set(['call_a']);
    const failsByCallID = new Map<string, number>();
    const store: ReturnType<typeof mockStore> = {
      writePartCalls: [] as Part[],
      writePart: async (part: Part) => {
        writes += 1;
        store.writePartCalls.push(part);
        if (failingIds.has((part as ToolPart).callID)) {
          const count = (failsByCallID.get((part as ToolPart).callID) ?? 0) + 1;
          failsByCallID.set((part as ToolPart).callID, count);
          if (count <= 2) throw new Error('transient');
        }
      },
    } as any;
    const v1 = mkViolation('call_a', 'orphan_running', { start: 100 });
    const v2 = mkViolation('call_b', 'orphan_running', { start: 200 });
    await synthesizeOrphans(store as unknown as SessionStore, 'session_x', [v1, v2]);
    // v2 should have been written exactly once; v1 three times (2 fails + 1 ok).
    const calledForA = store.writePartCalls.filter(
      (p) => (p as ToolPart).callID === 'call_a',
    ).length;
    const calledForB = store.writePartCalls.filter(
      (p) => (p as ToolPart).callID === 'call_b',
    ).length;
    expect(calledForA).toBe(3);
    expect(calledForB).toBe(1);
  }, 15000);
});

function mockStore(opts?: { failFirstN?: number; failAlways?: boolean }): {
  writePartCalls: Part[];
  writePart: (part: Part) => Promise<void>;
} {
  const calls: Part[] = [];
  let failCount = opts?.failFirstN ?? 0;
  return {
    writePartCalls: calls,
    writePart: async (part: Part) => {
      calls.push(part);
      if (opts?.failAlways) throw new Error('persistent-failure');
      if (failCount > 0) {
        failCount -= 1;
        throw new Error('transient-failure');
      }
    },
  };
}

function mkViolation(
  callID: string,
  reason: 'orphan_running' | 'orphan_pending_approval',
  time: { start: number },
): INV1Violation {
  const toolPart = {
    id: `part_${callID}`,
    sessionID: 'session_test',
    messageID: 'msg_test',
    type: 'tool',
    tool: 'test-tool',
    callID,
    state:
      reason === 'orphan_pending_approval'
        ? { status: 'pending_approval', input: {}, time }
        : { status: 'running', input: {}, time },
  } as unknown as ToolPart;
  return { messageId: 'msg_test', toolPart, reason };
}
