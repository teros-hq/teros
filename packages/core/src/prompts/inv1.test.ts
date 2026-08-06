/**
 * INV-1 detection tests (Phase 2.2 — TER-348).
 *
 * Verifies `assertInvariantINV1` correctly detects orphan tool_use parts
 * in a message history. Pure function — tests are deterministic and
 * fast.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { MessageWithParts, ToolPart } from '../session/types';
import { assertInvariantINV1, type INV1Violation } from './PromptBuilder';

const NODE_ENV_ORIG = process.env.NODE_ENV;

describe('assertInvariantINV1', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';  // suppress throw-on-detect for happy-path tests
  });

  afterEach(() => {
    process.env.NODE_ENV = NODE_ENV_ORIG;
  });

  it('returns ok=true for an empty history', () => {
    const result = assertInvariantINV1([]);
    expect(result.ok).toBe(true);
    expect(result.violations.length).toBe(0);
  });

  it('returns ok=true for a history with only user messages', () => {
    const messages: MessageWithParts[] = [
      mkMsg('user', 'msg_1', [{ type: 'text', text: 'hello' } as any]),
    ];
    const result = assertInvariantINV1(messages);
    expect(result.ok).toBe(true);
  });

  it('returns ok=true for assistant messages with only completed tools', () => {
    const messages: MessageWithParts[] = [
      mkMsg('assistant', 'msg_2', [
        mkTool('call_1', 'completed', { start: 100, end: 200 }),
      ]),
    ];
    const result = assertInvariantINV1(messages);
    expect(result.ok).toBe(true);
  });

  it('returns ok=true for assistant messages with only error tools', () => {
    const messages: MessageWithParts[] = [
      mkMsg('assistant', 'msg_3', [
        mkTool('call_2', 'error', { start: 100, end: 250 }),
      ]),
    ];
    const result = assertInvariantINV1(messages);
    expect(result.ok).toBe(true);
  });

  it('detects an orphan_running tool_use', () => {
    const messages: MessageWithParts[] = [
      mkMsg('assistant', 'msg_4', [
        mkTool('call_3', 'running', { start: 100 }),
      ]),
    ];
    const result = assertInvariantINV1(messages);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBe(1);
    const v = result.violations[0] as INV1Violation;
    expect(v.reason).toBe('orphan_running');
    expect(v.messageId).toBe('msg_4');
    expect(v.toolPart.callID).toBe('call_3');
  });

  it('detects an orphan_pending_approval tool_use', () => {
    const messages: MessageWithParts[] = [
      mkMsg('assistant', 'msg_5', [
        mkTool('call_4', 'pending_approval', { start: 100 }),
      ]),
    ];
    const result = assertInvariantINV1(messages);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBe(1);
    const v = result.violations[0] as INV1Violation;
    expect(v.reason).toBe('orphan_pending_approval');
  });

  it('detects multiple orphans across multiple messages', () => {
    const messages: MessageWithParts[] = [
      mkMsg('assistant', 'msg_a', [
        mkTool('call_a1', 'completed', { start: 100, end: 200 }),
        mkTool('call_a2', 'running', { start: 100 }),
      ]),
      mkMsg('assistant', 'msg_b', [mkTool('call_b1', 'pending_approval', { start: 300 })]),
    ];
    const result = assertInvariantINV1(messages);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBe(2);
    expect(result.violations.map((v) => v.toolPart.callID).sort()).toEqual([
      'call_a2',
      'call_b1',
    ]);
  });

  it('ignores tool parts inside user messages (impossible shape but defensive)', () => {
    const messages: MessageWithParts[] = [
      mkMsg('user', 'msg_x', [mkTool('call_x', 'running', { start: 1 })]),
    ];
    const result = assertInvariantINV1(messages);
    expect(result.ok).toBe(true);
  });

  it('returns violations without throwing — caller routes through synthesizeOrphans', () => {
    const messages: MessageWithParts[] = [
      mkMsg('assistant', 'msg_x', [mkTool('call_x', 'running', { start: 1 })]),
    ];
    expect(() => assertInvariantINV1(messages)).not.toThrow();
    const result = assertInvariantINV1(messages);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.reason).toBe('orphan_running');
  });

  // ── Gaps TER-469 ──────────────────────────────────────────────────────────

  it("detects a 'pending' tool_use as orphan_running (else-branch of the reason ternary)", () => {
    const messages: MessageWithParts[] = [
      mkMsg('assistant', 'msg_6', [mkTool('call_5', 'pending')]),
    ];
    const result = assertInvariantINV1(messages);
    expect(result.ok).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0]!.reason).toBe('orphan_running');
    expect(result.violations[0]!.messageId).toBe('msg_6');
  });

  it('ignores text parts mixed with an orphan tool part (exactly 1 violation)', () => {
    const messages: MessageWithParts[] = [
      mkMsg('assistant', 'msg_7', [
        { type: 'text', text: 'let me check' } as any,
        mkTool('call_6', 'running', { start: 1 }),
        { type: 'text', text: 'checking...' } as any,
      ]),
    ];
    const result = assertInvariantINV1(messages);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0]!.toolPart.callID).toBe('call_6');
  });

  it('violations preserve history order (message order, then part order)', () => {
    const messages: MessageWithParts[] = [
      mkMsg('assistant', 'msg_b', [
        mkTool('call_2', 'running', { start: 1 }),
        mkTool('call_3', 'pending_approval', { start: 2 }),
      ]),
      mkMsg('user', 'msg_u', [{ type: 'text', text: 'hi' } as any]),
      mkMsg('assistant', 'msg_a', [mkTool('call_1', 'running', { start: 3 })]),
    ];
    const result = assertInvariantINV1(messages);
    expect(result.violations.map((v) => v.toolPart.callID)).toEqual([
      'call_2',
      'call_3',
      'call_1',
    ]);
  });

  it('violation.toolPart is the SAME reference as the part in the history (no clone)', () => {
    const orphan = mkTool('call_ref', 'running', { start: 1 });
    const messages: MessageWithParts[] = [mkMsg('assistant', 'msg_r', [orphan])];
    const result = assertInvariantINV1(messages);
    expect(result.violations[0]!.toolPart).toBe(orphan);
  });

  it('assistant message with empty parts array → no violations', () => {
    const messages: MessageWithParts[] = [mkMsg('assistant', 'msg_e', [])];
    const result = assertInvariantINV1(messages);
    expect(result.ok).toBe(true);
    expect(result.violations.length).toBe(0);
  });
});

function mkMsg(role: 'user' | 'assistant', id: string, parts: any[]): MessageWithParts {
  return {
    info: {
      id,
      sessionID: 'session_test',
      role,
      time: { created: Date.now() },
    } as any,
    parts,
  };
}

function mkTool(
  callID: string,
  status: 'pending' | 'running' | 'pending_approval' | 'completed' | 'error',
  time?: { start: number; end?: number },
): ToolPart {
  const base: any = {
    id: `part_${callID}`,
    sessionID: 'session_test',
    messageID: 'msg_test',
    type: 'tool',
    tool: 'test-tool',
    callID,
  };
  if (status === 'pending') {
    base.state = { status: 'pending', input: {} };
  } else if (status === 'running') {
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
  } else if (status === 'error') {
    base.state = { status: 'error', input: {}, error: 'failed', time };
  }
  return base as ToolPart;
}
