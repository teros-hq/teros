/**
 * Unit — OpenAILLMAdapter.streamMessage delta assembly (TER-452)
 *
 * Tool-call arguments arrive FRAGMENTED across stream deltas (`{"q":` then
 * `"hello"}`). The adapter must concatenate them per tool index and only then
 * JSON.parse — a broken accumulation = corrupt tool input in prod (the exact
 * "JSON truncado entre deltas" failure). The mock SDK stream is faithful to the
 * OpenAI chunk shape; we assert the assembled `onToolCall` input, the stopReason,
 * and the usage extracted from the final chunk.
 */

import { describe, expect, it, mock } from 'bun:test';
import { OpenAILLMAdapter } from '../../../packages/core/src/llm/OpenAILLMAdapter';

function asyncIterable<T>(items: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const i of items) yield i;
    },
  };
}

/** Override the SDK client with a mock stream of the given chunks. */
function adapterStreaming(chunks: unknown[]) {
  const adapter = new OpenAILLMAdapter({ apiKey: 'test-key', model: 'gpt-test' });
  (adapter as any).client = {
    chat: { completions: { create: async () => asyncIterable(chunks) } },
  };
  return adapter;
}

describe('OpenAILLMAdapter.streamMessage — fragmented delta assembly', () => {
  it('concatenates tool-argument fragments across deltas, then parses', async () => {
    const adapter = adapterStreaming([
      { choices: [{ delta: { content: 'thinking…' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hel' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'lo"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    const onToolCall = mock(() => undefined);
    const onText = mock(() => undefined);

    const res = await (adapter as any).streamMessage({ messages: [], callbacks: { onText, onToolCall, onTextEnd: mock(() => undefined) } });

    expect(onText).toHaveBeenCalledWith('thinking…');
    // The three argument fragments → "{\"q\":\"hello\"}" → parsed object.
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall.mock.calls[0][0]).toEqual({ id: 'call_1', name: 'search', input: { q: 'hello' } });
    expect(res.stopReason).toBe('tool_calls');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('maps finish_reason length → max_tokens with no tool calls', async () => {
    const adapter = adapterStreaming([
      { choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }], usage: { prompt_tokens: 3, completion_tokens: 7 } },
    ]);
    const res = await (adapter as any).streamMessage({ messages: [], callbacks: {} });
    expect(res.stopReason).toBe('max_tokens');
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 7 });
  });

  it('plain text response → stopReason end_turn', async () => {
    const adapter = adapterStreaming([
      { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]);
    const res = await (adapter as any).streamMessage({ messages: [], callbacks: {} });
    expect(res.stopReason).toBe('end_turn');
  });
});
