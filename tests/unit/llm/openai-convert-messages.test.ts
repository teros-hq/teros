/**
 * Unit — OpenAILLMAdapter.convertMessages contract (TER-452)
 *
 * OpenAI's shape differs from Anthropic's: the assistant message carries a
 * `tool_calls` array whose `function.arguments` is a JSON STRING (not an object),
 * and each result is a separate `{ role: 'tool', tool_call_id }` message. The
 * pairing id (tool_calls[].id ↔ tool message.tool_call_id) must match. Errors
 * surface as `Error: …` content. Asserted on the exact payload.
 */

import { describe, expect, it } from 'bun:test';
import { OpenAILLMAdapter } from '../../../packages/core/src/llm/OpenAILLMAdapter';

const adapter = new OpenAILLMAdapter({ apiKey: 'test-key', model: 'gpt-test' });
const convert = (msgs: unknown[]): Promise<any[]> => (adapter as any).convertMessages(msgs, undefined);

const base = { id: 'p', sessionID: 's', messageID: 'm' };
const text = (t: string) => ({ ...base, type: 'text', text: t });
const completedTool = (callID: string, input: Record<string, unknown>, output: string) => ({
  ...base,
  type: 'tool',
  tool: 'search',
  callID,
  state: { status: 'completed', input, output, title: 't', metadata: {}, time: { start: 1, end: 2 } },
});
const errorTool = (callID: string, error: string) => ({
  ...base,
  type: 'tool',
  tool: 'search',
  callID,
  state: { status: 'error', input: {}, error, time: { start: 1, end: 2 } },
});
const msg = (role: 'user' | 'assistant', parts: unknown[]) => ({ info: { role }, parts });

describe('OpenAILLMAdapter.convertMessages', () => {
  it('emits assistant tool_calls + a tool message with the matching id', async () => {
    const out = await convert([msg('assistant', [text('searching'), completedTool('call_1', { q: 'x' }, 'result')])]);
    const assistant = out.find((m) => m.role === 'assistant' && m.tool_calls);
    const toolMsg = out.find((m) => m.role === 'tool');

    expect(assistant.content).toBe('searching');
    expect(assistant.tool_calls[0]).toMatchObject({ id: 'call_1', type: 'function', function: { name: 'search' } });
    expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'result' });
    // Pairing: the call id and the result id are the same value.
    expect(assistant.tool_calls[0].id).toBe(toolMsg.tool_call_id);
  });

  it('serialises tool arguments as a JSON STRING, not an object', async () => {
    const out = await convert([msg('assistant', [completedTool('c1', { a: 1, b: [2, 3] }, 'ok')])]);
    const tc = out.find((m) => m.tool_calls)?.tool_calls[0];
    expect(typeof tc.function.arguments).toBe('string');
    expect(JSON.parse(tc.function.arguments)).toEqual({ a: 1, b: [2, 3] });
  });

  it('renders an errored tool result as "Error: <msg>"', async () => {
    const out = await convert([msg('assistant', [errorTool('c1', 'boom')])]);
    const toolMsg = out.find((m) => m.role === 'tool');
    expect(toolMsg.content).toBe('Error: boom');
  });

  it('keeps a plain assistant text message without tool_calls', async () => {
    const out = await convert([msg('assistant', [text('just text')])]);
    const assistant = out.find((m) => m.role === 'assistant');
    expect(assistant.content).toBe('just text');
    expect(assistant.tool_calls).toBeUndefined();
  });
});
