/**
 * Unit — AnthropicOAuthAdapter.convertMessages contract (TER-452)
 *
 * Separate implementation from AnthropicLLMAdapter (OAuth/claude-code headers)
 * but the same payload contract: tool_use (assistant) → tool_result (user) with
 * sanitizeToolId applied IDENTICALLY on both sides, and an `is_error` flag on the
 * result. A drift between this and the API-key adapter would break OAuth sessions
 * silently, so it gets its own contract test.
 */

import { describe, expect, it } from 'bun:test';
import { AnthropicOAuthAdapter } from '../../../packages/core/src/llm/AnthropicOAuthAdapter';

const adapter = new AnthropicOAuthAdapter({ accessToken: 'tok', model: 'claude-test' } as any);
const convert = (msgs: unknown[]): Promise<any[]> => (adapter as any).convertMessages(msgs);

const base = { id: 'p', sessionID: 's', messageID: 'm' };
const tool = (callID: string, status: 'completed' | 'error', extra: Record<string, unknown>) => ({
  ...base,
  type: 'tool',
  tool: 'search',
  callID,
  state: { status, input: { q: 'x' }, title: 't', metadata: {}, time: { start: 1, end: 2 }, ...extra },
});
const msg = (role: 'user' | 'assistant', parts: unknown[]) => ({ info: { role }, parts });
const blocks = (m: any) => (Array.isArray(m?.content) ? m.content : []);

describe('AnthropicOAuthAdapter.convertMessages', () => {
  it('pairs tool_use → tool_result with sanitizeToolId identical on both sides', async () => {
    const out = await convert([msg('assistant', [tool('a.b/c!1', 'completed', { output: 'result' })])]);
    const toolUse = blocks(out.find((m) => m.role === 'assistant')).find((b: any) => b.type === 'tool_use');
    const toolResult = blocks(out.find((m) => m.role === 'user')).find((b: any) => b.type === 'tool_result');
    expect(toolUse).toMatchObject({ type: 'tool_use', id: 'a_b_c_1', name: 'search', input: { q: 'x' } });
    expect(toolResult.tool_use_id).toBe('a_b_c_1');
    expect(toolUse.id).toBe(toolResult.tool_use_id);
    expect(toolResult.is_error).toBe(false);
  });

  it('flags an errored tool result with is_error true', async () => {
    const out = await convert([msg('assistant', [tool('c1', 'error', { error: 'boom' })])]);
    const toolResult = blocks(out.find((m) => m.role === 'user')).find((b: any) => b.type === 'tool_result');
    expect(toolResult.is_error).toBe(true);
  });

  it('throws INV-1 for an orphan tool part', async () => {
    const orphan = { ...base, type: 'tool', tool: 'search', callID: 'c1', state: { status: 'pending' } };
    await expect(convert([msg('assistant', [orphan])])).rejects.toThrow(/INV-1 violation/);
  });
});
