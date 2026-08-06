/**
 * Unit — AnthropicLLMAdapter.streamMessage (TER-452)
 *
 * Anthropic delegates tool-input assembly to the SDK's `stream.finalMessage()`,
 * so the adapter's contract is: stream text deltas to onText, surface each
 * finalMessage tool_use block via onToolCall (with the SDK-parsed input), map the
 * stop reason (tool_calls / max_tokens / end_turn), and extract usage including
 * the prompt-cache token fields. Mock SDK stream is faithful to that surface.
 */

import { describe, expect, it, mock } from 'bun:test';
import { AnthropicLLMAdapter } from '../../../packages/core/src/llm/AnthropicLLMAdapter';

function makeStream(events: unknown[], finalMessage: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    finalMessage: async () => finalMessage,
  };
}

function adapterStreaming(events: unknown[], finalMessage: unknown) {
  const adapter = new AnthropicLLMAdapter({ apiKey: 'test-key', model: 'claude-test' });
  (adapter as any).client = { messages: { stream: () => makeStream(events, finalMessage) } };
  return adapter;
}

describe('AnthropicLLMAdapter.streamMessage', () => {
  it('streams text, surfaces the tool_use from finalMessage, maps tool_calls + usage', async () => {
    const adapter = adapterStreaming(
      [
        { type: 'content_block_start', content_block: { type: 'text' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'thinking…' } },
        { type: 'content_block_stop' },
      ],
      {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'hello' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
        model: 'claude-test',
        id: 'msg_1',
      },
    );
    const onText = mock(() => undefined);
    const onToolCall = mock(() => undefined);

    const res = await (adapter as any).streamMessage({ messages: [], callbacks: { onText, onToolCall, onTextEnd: mock(() => undefined) } });

    expect(onText).toHaveBeenCalledWith('thinking…');
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall.mock.calls[0][0]).toEqual({ id: 'tu_1', name: 'search', input: { q: 'hello' } });
    expect(res.stopReason).toBe('tool_calls');
    expect(res.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 });
  });

  it('maps stop_reason max_tokens when there are no tool calls', async () => {
    const adapter = adapterStreaming([], {
      content: [{ type: 'text', text: 'truncated' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 1, output_tokens: 9 },
    });
    const res = await (adapter as any).streamMessage({ messages: [], callbacks: {} });
    expect(res.stopReason).toBe('max_tokens');
  });

  it('plain text completion → stopReason end_turn', async () => {
    const adapter = adapterStreaming([], {
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const res = await (adapter as any).streamMessage({ messages: [], callbacks: {} });
    expect(res.stopReason).toBe('end_turn');
  });
});
