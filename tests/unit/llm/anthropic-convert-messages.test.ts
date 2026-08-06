/**
 * Unit — AnthropicLLMAdapter.convertMessages contract (TER-452)
 *
 * convertMessages turns Teros MessageWithParts into the exact Anthropic SDK
 * payload. The hard invariants: every tool_use (assistant) is immediately
 * followed by its tool_result (user); the id on BOTH sides is the SAME
 * `sanitizeToolId(callID)` (mismatch → Anthropic 400); and an orphan tool part
 * (INV-1: not completed/error, or missing time.end) throws loudly rather than
 * silently dropping. Asserted on the exact payload, not "it ran".
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicLLMAdapter } from '../../../packages/core/src/llm/AnthropicLLMAdapter';

const adapter = new AnthropicLLMAdapter({ apiKey: 'test-key', model: 'claude-test' });
const convert = (msgs: unknown[]): Promise<any[]> => (adapter as any).convertMessages(msgs);

const base = { id: 'p', sessionID: 's', messageID: 'm' };
const text = (t: string) => ({ ...base, type: 'text', text: t });
const completedTool = (callID: string, input: Record<string, unknown>, output: string, over: Record<string, unknown> = {}) => ({
  ...base,
  type: 'tool',
  tool: 'search',
  callID,
  state: { status: 'completed', input, output, title: 't', metadata: {}, time: { start: 1, end: 2 }, ...over },
});
const msg = (role: 'user' | 'assistant', parts: unknown[]) => ({ info: { role }, parts });

function blocks(m: any): any[] {
  return Array.isArray(m?.content) ? m.content : [];
}

describe('AnthropicLLMAdapter.convertMessages', () => {
  it('pairs a completed tool: assistant tool_use immediately followed by user tool_result', async () => {
    const out = await convert([msg('assistant', [text('searching'), completedTool('call_1', { q: 'x' }, 'result text')])]);

    const assistant = out.find((m) => m.role === 'assistant');
    const user = out.find((m) => m.role === 'user');
    const toolUse = blocks(assistant).find((b) => b.type === 'tool_use');
    const toolResult = blocks(user).find((b) => b.type === 'tool_result');

    expect(toolUse).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } });
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.tool_use_id).toBe('call_1');
    // Ordering: the user (tool_result) message comes right after the assistant (tool_use).
    expect(out.indexOf(user)).toBe(out.indexOf(assistant) + 1);
  });

  it('applies sanitizeToolId IDENTICALLY on both sides (ids must match)', async () => {
    const out = await convert([msg('assistant', [completedTool('a.b/c!1', {}, 'ok')])]);
    const toolUse = blocks(out.find((m) => m.role === 'assistant')).find((b) => b.type === 'tool_use');
    const toolResult = blocks(out.find((m) => m.role === 'user')).find((b) => b.type === 'tool_result');
    // Non-[a-zA-Z0-9_-] → '_'
    expect(toolUse.id).toBe('a_b_c_1');
    expect(toolResult.tool_use_id).toBe('a_b_c_1');
    expect(toolUse.id).toBe(toolResult.tool_use_id);
  });

  it('throws INV-1 (status branch) for an orphan tool part — even if it carries a time.end', async () => {
    // time.end present so the status check is the ONLY thing that can reject:
    // asserts the specific status message, not just "some INV-1 error".
    const orphan = { ...base, type: 'tool', tool: 'search', callID: 'c1', state: { status: 'pending', time: { start: 1, end: 2 } } };
    await expect(convert([msg('assistant', [orphan])])).rejects.toThrow(/has status=pending. Expected 'completed' or 'error'/);
  });

  it('throws INV-1 for a completed tool missing time.end (synthetic recovery missing)', async () => {
    const noEnd = completedTool('c1', {}, 'ok', { time: { start: 1 } });
    await expect(convert([msg('assistant', [noEnd])])).rejects.toThrow(/INV-1 violation.*time\.end|Synthetic recovery/);
  });

  it('keeps a plain user text message as a single user message', async () => {
    const out = await convert([msg('user', [text('hello')])]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });
});
