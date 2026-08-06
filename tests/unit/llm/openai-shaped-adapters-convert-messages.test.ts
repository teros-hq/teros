/**
 * Unit — OpenAI-shaped adapters convertMessages contract (TER-452)
 *
 * OpenRouter, Zhipu, Ollama and OpenAICompatible all emit the OpenAI
 * chat-completions shape: an assistant message with `tool_calls`
 * (function.arguments as a JSON STRING) plus a `{ role: 'tool', tool_call_id }`
 * result. This drives the SAME contract against all four — if any drifts from the
 * shared shape (wrong pairing id, args as object), its row goes red.
 */

import { describe, expect, it } from 'bun:test';
import { OllamaLLMAdapter } from '../../../packages/core/src/llm/OllamaLLMAdapter';
import { OpenAICompatibleLLMAdapter } from '../../../packages/core/src/llm/OpenAICompatibleLLMAdapter';
import { OpenRouterLLMAdapter } from '../../../packages/core/src/llm/OpenRouterLLMAdapter';
import { ZhipuLLMAdapter } from '../../../packages/core/src/llm/ZhipuLLMAdapter';

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

const ADAPTERS: Array<[string, () => any]> = [
  ['OpenRouter', () => new OpenRouterLLMAdapter({ apiKey: 'k', model: 'm' } as any)],
  ['Zhipu', () => new ZhipuLLMAdapter({ apiKey: 'k', model: 'm' } as any)],
  ['Ollama', () => new OllamaLLMAdapter({ baseUrl: 'http://localhost:1', model: 'm' } as any)],
  ['OpenAICompatible', () => new OpenAICompatibleLLMAdapter({ baseUrl: 'http://localhost:1', model: 'm' } as any)],
];

describe('OpenAI-shaped adapters — convertMessages', () => {
  for (const [name, make] of ADAPTERS) {
    it(`${name}: emits tool_calls + tool message with matching id and JSON-string args`, async () => {
      const out = await (make() as any).convertMessages([msg('assistant', [text('hi'), completedTool('call_1', { q: 'x' }, 'result')])], undefined);
      const assistant = out.find((m: any) => m.role === 'assistant' && m.tool_calls);
      const toolMsg = out.find((m: any) => m.role === 'tool');

      expect(assistant.tool_calls[0]).toMatchObject({ id: 'call_1', type: 'function', function: { name: 'search' } });
      expect(typeof assistant.tool_calls[0].function.arguments).toBe('string');
      expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ q: 'x' });
      expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'result' });
      // Pairing: call id and result id are the same value.
      expect(assistant.tool_calls[0].id).toBe(toolMsg.tool_call_id);
    });
  }
});
