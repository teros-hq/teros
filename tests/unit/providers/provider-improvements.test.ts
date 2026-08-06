/**
 * Tests for provider improvements:
 * - Zhipu new models in definitions.ts
 * - OpenRouter customModel in discoverModels
 * - openai-compatible provider type
 * - OpenAICompatibleLLMAdapter constructor
 * - MiniMax provider (Anthropic-compatible)
 * - openai-compatible /v1/models discovery
 */
import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import {
  getActiveModelsByProvider,
  MODEL_DEFINITIONS,
} from '../../../packages/backend/src/models/definitions';
import { OpenAICompatibleLLMAdapter } from '../../../packages/core/src/llm/OpenAICompatibleLLMAdapter';
import { AnthropicLLMAdapter } from '../../../packages/core/src/llm/AnthropicLLMAdapter';
import { createLLMClientManager } from '../../../packages/backend/src/handlers/message/llm-client-manager';
import { ProviderService } from '../../../packages/backend/src/services/provider-service';
import type { ILLMClient } from '@teros/core';

// ===========================================================================
// 1. Zhipu new models
// ===========================================================================

describe('Zhipu new models in definitions', () => {
  it('should include glm-5.1 for zhipu provider', () => {
    const models = getActiveModelsByProvider('zhipu');
    const ids = models.map((m) => m.modelId);
    expect(ids).toContain('glm-5.1');
  });

  it('should include glm-5 for zhipu provider', () => {
    const models = getActiveModelsByProvider('zhipu');
    const ids = models.map((m) => m.modelId);
    expect(ids).toContain('glm-5');
  });

  it('should include glm-5-turbo for zhipu provider', () => {
    const models = getActiveModelsByProvider('zhipu');
    const ids = models.map((m) => m.modelId);
    expect(ids).toContain('glm-5-turbo');
  });

  it('should include glm-4.7-flash for zhipu provider', () => {
    const models = getActiveModelsByProvider('zhipu');
    const ids = models.map((m) => m.modelId);
    expect(ids).toContain('glm-4.7-flash');
  });

  it('should include glm-4.7-flashx for zhipu provider', () => {
    const models = getActiveModelsByProvider('zhipu');
    const ids = models.map((m) => m.modelId);
    expect(ids).toContain('glm-4.7-flashx');
  });

  it('should include glm-5.1-coding for zhipu-coding provider', () => {
    const models = getActiveModelsByProvider('zhipu-coding');
    const ids = models.map((m) => m.modelId);
    expect(ids).toContain('glm-5.1-coding');
  });

  it('should include glm-5-coding for zhipu-coding provider', () => {
    const models = getActiveModelsByProvider('zhipu-coding');
    const ids = models.map((m) => m.modelId);
    expect(ids).toContain('glm-5-coding');
  });

  it('glm-5.1 should have thinking capability', () => {
    const models = getActiveModelsByProvider('zhipu');
    const glm51 = models.find((m) => m.modelId === 'glm-5.1');
    expect(glm51).toBeDefined();
    expect(glm51?.capabilities.thinking).toBe(true);
  });

  it('glm-5-turbo should not have thinking capability', () => {
    const models = getActiveModelsByProvider('zhipu');
    const turbo = models.find((m) => m.modelId === 'glm-5-turbo');
    expect(turbo).toBeDefined();
    expect(turbo?.capabilities.thinking).toBe(false);
  });

  it('glm-5.1 coding variant should use correct modelString', () => {
    const models = getActiveModelsByProvider('zhipu-coding');
    const coding = models.find((m) => m.modelId === 'glm-5.1-coding');
    expect(coding?.modelString).toBe('glm-5.1');
  });

  it('should include glm-5.2 for zhipu provider', () => {
    const ids = getActiveModelsByProvider('zhipu').map((m) => m.modelId);
    expect(ids).toContain('glm-5.2');
  });

  it('should include glm-5.2-coding for zhipu-coding provider', () => {
    const ids = getActiveModelsByProvider('zhipu-coding').map((m) => m.modelId);
    expect(ids).toContain('glm-5.2-coding');
  });

  it('glm-5.2 should have thinking capability and no vision (text-only)', () => {
    const glm52 = getActiveModelsByProvider('zhipu').find((m) => m.modelId === 'glm-5.2');
    expect(glm52).toBeDefined();
    expect(glm52?.capabilities.thinking).toBe(true);
    expect(glm52?.capabilities.vision).toBe(false);
  });

  it('glm-5.2 should expose the 1M context window', () => {
    const glm52 = getActiveModelsByProvider('zhipu').find((m) => m.modelId === 'glm-5.2');
    expect(glm52?.context.maxTokens).toBe(1000000);
  });

  // Routing field is modelString, not modelId — both 5.2 entries hit `glm-5.2`.
  it('both glm-5.2 entries route to modelString glm-5.2', () => {
    const std = getActiveModelsByProvider('zhipu').find((m) => m.modelId === 'glm-5.2');
    const coding = getActiveModelsByProvider('zhipu-coding').find(
      (m) => m.modelId === 'glm-5.2-coding',
    );
    expect(std?.modelString).toBe('glm-5.2');
    expect(coding?.modelString).toBe('glm-5.2');
  });

  it('glm-5.2 leaves headroom for a full-length output under the 1M cap', () => {
    // Regression guard: triggerAt + maxOutputTokens must stay <= maxTokens so a
    // turn at the compaction trigger plus a max-length output never overflows.
    const glm52 = getActiveModelsByProvider('zhipu').find((m) => m.modelId === 'glm-5.2');
    expect(glm52).toBeDefined();
    expect(glm52!.compaction.triggerAt + glm52!.context.maxOutputTokens).toBeLessThanOrEqual(
      glm52!.context.maxTokens,
    );
  });

  // glm-4.6v / glm-4 are general-purpose models; they belong to the `zhipu`
  // provider, not `zhipu-coding`, regardless of which file they live in.
  it('glm-4.6v is exposed under the zhipu provider, not zhipu-coding', () => {
    expect(getActiveModelsByProvider('zhipu').map((m) => m.modelId)).toContain('glm-4.6v');
    expect(getActiveModelsByProvider('zhipu-coding').map((m) => m.modelId)).not.toContain(
      'glm-4.6v',
    );
  });
});

// ===========================================================================
// 1b. MODEL_DEFINITIONS — structural invariants (lint-as-test guard)
// Cheap guards that catch whole classes of copy-paste bugs across the catalog.
// ===========================================================================

describe('MODEL_DEFINITIONS — structural invariants', () => {
  it('every modelId is globally unique', () => {
    const ids = MODEL_DEFINITIONS.map((m) => m.modelId);
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    expect(dupes).toEqual([]);
  });

  it('every model has a non-empty modelString', () => {
    const empty = MODEL_DEFINITIONS.filter(
      (m) => typeof m.modelString !== 'string' || m.modelString.length === 0,
    ).map((m) => m.modelId);
    expect(empty).toEqual([]);
  });

  it('every model in a per-provider file carries that provider', () => {
    // Catches the "right array, wrong provider field" anomaly (e.g. a zhipu
    // entry parked inside MODELS_ZHIPU_CODING).
    const zhipu = getActiveModelsByProvider('zhipu');
    const coding = getActiveModelsByProvider('zhipu-coding');
    expect(zhipu.every((m) => m.provider === 'zhipu')).toBe(true);
    expect(coding.every((m) => m.provider === 'zhipu-coding')).toBe(true);
  });

  it('maxOutputTokens never exceeds the context window', () => {
    const bad = MODEL_DEFINITIONS.filter(
      (m) => m.context.maxOutputTokens > m.context.maxTokens,
    ).map((m) => m.modelId);
    expect(bad).toEqual([]);
  });

  it('compaction thresholds are strictly ordered below the context window', () => {
    const bad = MODEL_DEFINITIONS.filter((m) => {
      const { protectRecent, targetSize, triggerAt } = m.compaction;
      return !(
        protectRecent < targetSize &&
        targetSize < triggerAt &&
        triggerAt < m.context.maxTokens
      );
    }).map((m) => m.modelId);
    expect(bad).toEqual([]);
  });
});

// ===========================================================================
// 2. OpenAICompatibleLLMAdapter constructor
// ===========================================================================

describe('OpenAICompatibleLLMAdapter', () => {
  it('should throw if model is missing', () => {
    expect(() =>
      new OpenAICompatibleLLMAdapter({ baseUrl: 'https://example.com', model: '' }),
    ).toThrow('model is required');
  });

  it('should throw if baseUrl is missing', () => {
    expect(() =>
      new OpenAICompatibleLLMAdapter({ baseUrl: '', model: 'qwen3.5' }),
    ).toThrow('baseUrl is required');
  });

  it('should construct without apiKey', () => {
    expect(() =>
      new OpenAICompatibleLLMAdapter({ baseUrl: 'https://tower.romerolabs.dev', model: 'qwen3.5' }),
    ).not.toThrow();
  });

  it('should construct with apiKey and customHeaders', () => {
    expect(() =>
      new OpenAICompatibleLLMAdapter({
        baseUrl: 'https://example.com',
        model: 'llama3',
        apiKey: 'sk-test',
        customHeaders: {
          'CF-Access-Client-Id': 'abc.access',
          'CF-Access-Client-Secret': 'secret',
        },
      }),
    ).not.toThrow();
  });

  it('getProviderInfo should return openai-compatible', () => {
    const adapter = new OpenAICompatibleLLMAdapter({
      baseUrl: 'https://example.com',
      model: 'qwen3.5',
    });
    expect(adapter.getProviderInfo().name).toBe('OpenAI-Compatible');
    expect(adapter.getProviderInfo().model).toBe('qwen3.5');
  });
});

// ===========================================================================
// 3. LLMClientManager — openai-compatible does not require apiKey
// ===========================================================================

describe('LLMClientManager — openai-compatible provider', () => {
  const mockClient = (): ILLMClient =>
    ({
      streamMessage: mock(() => Promise.resolve({ stopReason: 'end_turn', usage: {} })),
      getProviderInfo: mock(() => ({ name: 'mock', model: 'mock', capabilities: {} })),
    }) as unknown as ILLMClient;

  it('openai-compatible should be in SUPPORTED_PROVIDERS (returns non-null with mock)', async () => {
    const manager = createLLMClientManager({ mockClient: mockClient() });

    const config = {
      provider: 'openai-compatible' as const,
      modelString: 'qwen3.5',
      maxTokens: 4096,
      providerConfig: { baseUrl: 'https://tower.romerolabs.dev' },
      context: { maxTokens: 128000 },
    };

    const resolvedCredentials = {
      providerId: 'prov_tower',
      providerType: 'openai-compatible' as const,
      // No apiKey — Tower uses custom headers
    };

    const client = await manager.getClient(config, resolvedCredentials);
    expect(client).not.toBeNull();
  });
});

// ===========================================================================
// 4. discoverModels — OpenRouter customModel appended
// ===========================================================================

describe('discoverModels — OpenRouter customModel', () => {
  it('openrouter definitions should not contain openrouter/free by default', () => {
    const models = getActiveModelsByProvider('openrouter');
    const freeModel = models.find((m) => m.modelString === 'openrouter/free');
    expect(freeModel).toBeUndefined();
  });

  it('openrouter definitions should include pre-defined models', () => {
    const models = getActiveModelsByProvider('openrouter');
    expect(models.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 5. MiniMax provider (Anthropic-compatible)
// ===========================================================================

describe('MiniMax model definitions', () => {
  it('should return 7 active models for minimax provider', () => {
    const models = getActiveModelsByProvider('minimax');
    expect(models.length).toBe(7);
  });

  it('should include M2.7 flagship model', () => {
    const models = getActiveModelsByProvider('minimax');
    const m27 = models.find((m) => m.modelId === 'minimax-m2.7');
    expect(m27).toBeDefined();
    expect(m27?.modelString).toBe('MiniMax-M2.7');
  });

  it('should include M2.7-highspeed variant', () => {
    const models = getActiveModelsByProvider('minimax');
    const hs = models.find((m) => m.modelId === 'minimax-m2.7-highspeed');
    expect(hs).toBeDefined();
    expect(hs?.modelString).toBe('MiniMax-M2.7-highspeed');
  });

  it('M2.7 should have thinking capability', () => {
    const models = getActiveModelsByProvider('minimax');
    const m27 = models.find((m) => m.modelId === 'minimax-m2.7');
    expect(m27?.capabilities.thinking).toBe(true);
  });

  it('M2.5 should not have thinking capability', () => {
    const models = getActiveModelsByProvider('minimax');
    const m25 = models.find((m) => m.modelId === 'minimax-m2.5');
    expect(m25?.capabilities.thinking).toBe(false);
  });

  it('all MiniMax models should have vision: false', () => {
    const models = getActiveModelsByProvider('minimax');
    for (const m of models) {
      expect(m.capabilities.vision).toBe(false);
    }
  });

  it('all MiniMax models should have 204800 context tokens', () => {
    const models = getActiveModelsByProvider('minimax');
    for (const m of models) {
      expect(m.context.maxTokens).toBe(204800);
    }
  });
});

describe('AnthropicLLMAdapter — baseURL and providerName', () => {
  it('should accept baseURL and set providerName in getProviderInfo', () => {
    const adapter = new AnthropicLLMAdapter({
      apiKey: 'test-key',
      model: 'MiniMax-M2.7',
      baseURL: 'https://api.minimax.io/anthropic',
      providerName: 'MiniMax',
    });
    const info = adapter.getProviderInfo();
    expect(info.name).toBe('MiniMax');
    expect(info.model).toBe('MiniMax-M2.7');
  });

  it('should default providerName to Anthropic when not provided', () => {
    const adapter = new AnthropicLLMAdapter({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-5',
    });
    const info = adapter.getProviderInfo();
    expect(info.name).toBe('Anthropic');
  });

  it('minimax should be in SUPPORTED_PROVIDERS (returns non-null with mock)', async () => {
    const mockLLM: ILLMClient = {
      streamMessage: mock(() => Promise.resolve({ stopReason: 'end_turn' as const, usage: {} })),
      getProviderInfo: mock(() => ({ name: 'mock', model: 'mock', capabilities: {} })),
    } as unknown as ILLMClient;

    const manager = createLLMClientManager({ mockClient: mockLLM });

    const config = {
      provider: 'minimax' as const,
      modelString: 'MiniMax-M2.7',
      maxTokens: 8192,
      context: { maxTokens: 204800 },
    };

    const resolvedCredentials = {
      providerId: 'prov_minimax',
      providerType: 'minimax' as const,
      apiKey: 'test-minimax-key',
    };

    const client = await manager.getClient(config, resolvedCredentials);
    expect(client).not.toBeNull();
  });
});

// ===========================================================================
// 6. openai-compatible /v1/models discovery
// ===========================================================================

describe('ProviderService.discoverOpenAICompatibleModels', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const makeService = () => new ProviderService({} as any);

  it('queries /v1/models and returns one ProviderModel per entry', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = mock(async (url: any, init?: any) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          data: [
            { id: 'qwen2.5-coder:32b' },
            { id: 'llama3.3' },
            { id: '' },
            { id: '   ' },
            { not_id: 'skip' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as any;

    const service = makeService();
    const models = await (service as any).discoverOpenAICompatibleModels(
      'https://tower.romerolabs.dev/',
      'sk-test',
      { 'CF-Access-Client-Id': 'abc.access' },
    );

    expect(models).toHaveLength(2);
    expect(models[0].modelId).toBe('openai-compatible-qwen2-5-coder-32b');
    expect(models[0].modelString).toBe('qwen2.5-coder:32b');
    expect(models[1].modelId).toBe('openai-compatible-llama3-3');
    expect(models[1].modelString).toBe('llama3.3');
    expect(models[0].capabilities.streaming).toBe(true);
    expect(models[0].capabilities.tools).toBe(true);

    // URL: trailing slash trimmed + /v1/models appended
    expect(calls[0].url).toBe('https://tower.romerolabs.dev/v1/models');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['CF-Access-Client-Id']).toBe('abc.access');
  });

  it('skips duplicating /v1 when baseUrl already ends in /v1', async () => {
    const calls: string[] = [];
    global.fetch = mock(async (url: any) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 });
    }) as any;

    const service = makeService();
    await (service as any).discoverOpenAICompatibleModels('https://api.example.com/v1');
    expect(calls[0]).toBe('https://api.example.com/v1/models');
  });

  it('falls back to pinned config.model when fetch returns non-ok', async () => {
    global.fetch = mock(
      async () =>
        new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    ) as any;

    const service = makeService();
    const models = await (service as any).discoverOpenAICompatibleModels(
      'https://private.example.com',
      undefined,
      undefined,
      'qwen3.5',
    );

    expect(models).toHaveLength(1);
    expect(models[0].modelString).toBe('qwen3.5');
    expect(models[0].modelId).toBe('openai-compatible-qwen3-5');
  });

  it('falls back to pinned config.model when /v1/models returns empty data', async () => {
    global.fetch = mock(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as any;

    const service = makeService();
    const models = await (service as any).discoverOpenAICompatibleModels(
      'https://empty.example.com',
      undefined,
      undefined,
      'my-pinned',
    );

    expect(models).toHaveLength(1);
    expect(models[0].modelString).toBe('my-pinned');
  });

  it('throws when discovery fails and no fallback model is pinned', async () => {
    global.fetch = mock(async () => {
      throw new Error('network down');
    }) as any;

    const service = makeService();
    await expect(
      (service as any).discoverOpenAICompatibleModels('https://dead.example.com'),
    ).rejects.toThrow(/could not discover models/);
  });

  it('omits Authorization header when apiKey is absent', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = mock(async (url: any, init?: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: [{ id: 'only' }] }), { status: 200 });
    }) as any;

    const service = makeService();
    await (service as any).discoverOpenAICompatibleModels('https://no-key.example.com');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.Accept).toBe('application/json');
  });

  // ===========================================================================
  // 6b. Budget defaults: reasoning-capable endpoints need headroom
  // ===========================================================================

  it('discovered openai-compatible models default to 32768 maxOutputTokens', async () => {
    global.fetch = mock(
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'qwopus3.5-27b' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as any;

    const service = makeService();
    const [model] = await (service as any).discoverOpenAICompatibleModels(
      'https://tower.example.com',
    );

    // Previous 8192 default strangled reasoning models (Qwopus/QwQ/DeepSeek R1)
    // because reasoning_content shares the max_tokens pool with content. 32768
    // gives reasoning + answer real headroom without being wasteful.
    expect(model.context.maxOutputTokens).toBe(32768);
  });
});

// ===========================================================================
// 7. OpenAICompatibleLLMAdapter — reasoning budget overflow detection
// ===========================================================================

describe('OpenAICompatibleLLMAdapter reasoning budget overflow', () => {
  // Minimal async iterable helper — yields chunks shaped like OpenAI SSE deltas
  const asyncStream = (chunks: any[]): AsyncIterable<any> => ({
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () =>
          i < chunks.length
            ? { value: chunks[i++], done: false }
            : { value: undefined, done: true },
      };
    },
  });

  const makeAdapterWithStream = (chunks: any[]) => {
    const adapter = new OpenAICompatibleLLMAdapter({
      baseUrl: 'https://tower.example.com',
      model: 'qwopus-test',
    });
    // Monkey-patch the inner OpenAI SDK client to avoid any network I/O.
    (adapter as any).client = {
      chat: {
        completions: {
          create: mock(async () => asyncStream(chunks)),
        },
      },
    };
    return adapter;
  };

  it('reasoning-only stream (no content, finish_reason=stop) is rewritten to max_tokens', async () => {
    const adapter = makeAdapterWithStream([
      { choices: [{ delta: { reasoning_content: 'thinking about it...' } }] },
      { choices: [{ delta: { reasoning_content: ' more thinking...' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);

    const onText = mock(() => {});
    const response = await adapter.streamMessage({
      messages: [],
      callbacks: { onText },
    });

    // Budget-overflow masquerade: we promote "stop" to max_tokens so the
    // caller can surface/retry rather than saving an empty assistant turn.
    expect(response.stopReason).toBe('max_tokens');
    expect(onText).not.toHaveBeenCalled();
    expect((response.metadata as any)?.reasoningChars).toBeGreaterThan(0);
    expect((response.metadata as any)?.contentChars).toBe(0);
  });

  it('content-only stream preserves end_turn (no reasoning diagnostics)', async () => {
    const adapter = makeAdapterWithStream([
      { choices: [{ delta: { content: 'Hola' } }] },
      { choices: [{ delta: { content: ' mundo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);

    const onText = mock(() => {});
    const response = await adapter.streamMessage({
      messages: [],
      callbacks: { onText },
    });

    expect(response.stopReason).toBe('end_turn');
    expect(onText).toHaveBeenCalledTimes(2);
    expect((response.metadata as any)?.reasoningChars).toBe(0);
    expect((response.metadata as any)?.contentChars).toBe(10); // "Hola" + " mundo"
  });

  it('reasoning + content stream emits only content via onText and preserves end_turn', async () => {
    const adapter = makeAdapterWithStream([
      { choices: [{ delta: { reasoning_content: 'let me think' } }] },
      { choices: [{ delta: { content: 'The answer is 42' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);

    const onText = mock(() => {});
    const response = await adapter.streamMessage({
      messages: [],
      callbacks: { onText },
    });

    expect(response.stopReason).toBe('end_turn');
    // Reasoning is diagnostic-only; it must NOT be forwarded to onText (would
    // otherwise be mixed into the assistant message text).
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('The answer is 42');
    expect((response.metadata as any)?.reasoningChars).toBeGreaterThan(0);
    expect((response.metadata as any)?.contentChars).toBeGreaterThan(0);
  });

  it('honors explicit finish_reason=length as max_tokens regardless of reasoning', async () => {
    const adapter = makeAdapterWithStream([
      { choices: [{ delta: { content: 'partial' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]);

    const response = await adapter.streamMessage({
      messages: [],
      callbacks: {},
    });

    expect(response.stopReason).toBe('max_tokens');
  });

  it('tool_calls win over reasoning-only heuristic', async () => {
    const adapter = makeAdapterWithStream([
      { choices: [{ delta: { reasoning_content: 'deciding which tool' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    const response = await adapter.streamMessage({
      messages: [],
      callbacks: {},
    });

    // Even though reasoningChars > 0 and contentChars === 0, the tool call
    // means the turn is genuinely finished via tool_calls, not overflow.
    expect(response.stopReason).toBe('tool_calls');
  });
});
