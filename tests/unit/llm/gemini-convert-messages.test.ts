/**
 * Unit — GeminiLLMAdapter.convertMessages contract (TER-452)
 *
 * Gemini's shape is distinct again: a tool call is a `functionCall` part in a
 * `model` turn and its result a `functionResponse` part in the NEXT `user` turn;
 * the paired `id` must match. `thoughtSignature` is a Part-level sibling of
 * functionCall (NOT nested inside it) — a regression that nested it would drop
 * Gemini's reasoning continuity. Errors surface as `response.error`.
 */

import { describe, expect, it } from 'bun:test';
import { GeminiLLMAdapter } from '../../../packages/core/src/llm/GeminiLLMAdapter';

const adapter = new GeminiLLMAdapter({ apiKey: 'test-key', model: 'gemini-test' });
const convert = (msgs: unknown[]): Promise<any[]> => (adapter as any).convertMessages(msgs);

const base = { id: 'p', sessionID: 's', messageID: 'm' };
const completedTool = (callID: string, input: Record<string, unknown>, output: string, over: Record<string, unknown> = {}) => ({
  ...base,
  type: 'tool',
  tool: 'search',
  callID,
  state: { status: 'completed', input, output, title: 't', metadata: {}, time: { start: 1, end: 2 } },
  ...over,
});
const errorTool = (callID: string, error: string) => ({
  ...base,
  type: 'tool',
  tool: 'search',
  callID,
  state: { status: 'error', input: {}, error, time: { start: 1, end: 2 } },
});
const msg = (role: 'user' | 'assistant', parts: unknown[]) => ({ info: { role }, parts });

// Gemini prepends an empty `user` turn when history starts with a model turn,
// so scan ALL turns of the role for the part (not just the first matching turn).
const fcOf = (out: any[]) => out.flatMap((c) => (c.role === 'model' ? c.parts : [])).find((p: any) => p.functionCall);
const frOf = (out: any[]) => out.flatMap((c) => (c.role === 'user' ? c.parts : [])).find((p: any) => p.functionResponse);

describe('GeminiLLMAdapter.convertMessages', () => {
  it('emits functionCall (model turn) + functionResponse (user turn) with the paired id', async () => {
    const out = await convert([msg('assistant', [completedTool('call_1', { q: 'x' }, 'result')])]);
    const fc = fcOf(out);
    const fr = frOf(out);
    expect(fc.functionCall).toMatchObject({ id: 'call_1', name: 'search', args: { q: 'x' } });
    expect(fr.functionResponse).toMatchObject({ id: 'call_1', name: 'search', response: { output: 'result' } });
    expect(fc.functionCall.id).toBe(fr.functionResponse.id);
  });

  it('emits thoughtSignature as a Part-level sibling, not nested in functionCall', async () => {
    const out = await convert([msg('assistant', [completedTool('c1', {}, 'ok', { metadata: { thoughtSignature: 'sig123' } })])]);
    const fc = fcOf(out);
    expect(fc.thoughtSignature).toBe('sig123');
    expect(fc.functionCall.thoughtSignature).toBeUndefined();
  });

  it('omits thoughtSignature when absent', async () => {
    const out = await convert([msg('assistant', [completedTool('c1', {}, 'ok')])]);
    expect(fcOf(out)).not.toHaveProperty('thoughtSignature');
  });

  it('renders an errored tool as response.error', async () => {
    const out = await convert([msg('assistant', [errorTool('c1', 'boom')])]);
    expect(frOf(out).functionResponse.response).toEqual({ error: 'boom' });
  });

  it('throws INV-1 for an orphan tool part', async () => {
    const orphan = { ...base, type: 'tool', tool: 'search', callID: 'c1', state: { status: 'pending' } };
    await expect(convert([msg('assistant', [orphan])])).rejects.toThrow(/INV-1 violation.*status=pending/);
  });
});
