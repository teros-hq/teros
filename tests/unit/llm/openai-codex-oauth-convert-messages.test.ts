/**
 * Unit — OpenAICodexOAuthAdapter.convertMessages contract (TER-452)
 *
 * Codex uses the OpenAI RESPONSES API, a 4th distinct shape: a tool call is a
 * top-level `{ type: 'function_call', call_id, name, arguments }` item (arguments
 * a JSON STRING) and its result a `{ type: 'function_call_output', call_id, output }`
 * item; assistant text is `{ type: 'output_text' }`. The paired `call_id` must
 * match. Asserted on the exact payload.
 */

import { describe, expect, it } from 'bun:test';
import { OpenAICodexOAuthAdapter } from '../../../packages/core/src/llm/OpenAICodexOAuthAdapter';

const adapter = new OpenAICodexOAuthAdapter({ tokens: { accessToken: 'tok' }, model: 'codex-test' } as any);
const convert = (msgs: unknown[]): Promise<any[]> => (adapter as any).convertMessages(msgs);

const base = { id: 'p', sessionID: 's', messageID: 'm' };
const text = (t: string) => ({ ...base, type: 'text', text: t });
const completedTool = (callID: string, input: Record<string, unknown>, output: string) => ({
  ...base,
  type: 'tool',
  tool: 'search',
  callID,
  state: { status: 'completed', input, output, title: 't', metadata: {}, time: { start: 1, end: 2 } },
});
const msg = (role: 'user' | 'assistant', parts: unknown[]) => ({ info: { role }, parts });

describe('OpenAICodexOAuthAdapter.convertMessages', () => {
  it('emits function_call + function_call_output items with the paired call_id', async () => {
    const out = await convert([msg('assistant', [text('hi'), completedTool('call_1', { q: 'x' }, 'result')])]);
    const call = out.find((i: any) => i.type === 'function_call');
    const output = out.find((i: any) => i.type === 'function_call_output');

    expect(call).toMatchObject({ type: 'function_call', call_id: 'call_1', name: 'search' });
    expect(typeof call.arguments).toBe('string');
    expect(JSON.parse(call.arguments)).toEqual({ q: 'x' });
    expect(output).toMatchObject({ type: 'function_call_output', call_id: 'call_1', output: 'result' });
    expect(call.call_id).toBe(output.call_id);
  });

  it('renders assistant text as an output_text content part', async () => {
    const out = await convert([msg('assistant', [text('hello')])]);
    const assistant = out.find((i: any) => i.role === 'assistant');
    expect(assistant.content).toEqual([{ type: 'output_text', text: 'hello' }]);
  });
});
