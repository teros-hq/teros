/**
 * Tests for `reconcileWithRuntimeModel` — the pure function that reconciles
 * an EffectiveLLMConfig built from the nominal core model with the metadata
 * of the runtime provider model actually serving the request.
 *
 * This is the load-bearing fix for "agent stays silent when core.modelId
 * points to a model from one family but the agent has a provider of a
 * different family assigned" (e.g. iria → Claude Sonnet nominally, but
 * Tower/Qwopus over openai-compatible as the active provider).
 */
import { describe, expect, it } from 'bun:test';
import {
  reconcileWithRuntimeModel,
  type EffectiveLLMConfig,
  type RuntimeProviderModel,
} from '../../../packages/backend/src/services/model-service';

/** Claude-family nominal config — matches Rai's iria core resolution. */
const claudeNominal: EffectiveLLMConfig = {
  modelId: 'claude-sonnet-4-5',
  provider: 'anthropic',
  modelString: 'claude-sonnet-4-5-20250929',
  temperature: 1.0,
  maxTokens: 8192,
  maxTokensUserOverride: undefined,
  capabilities: { streaming: true, tools: true, vision: true, thinking: true },
  context: { maxTokens: 200000, maxOutputTokens: 8192 },
  compaction: { triggerAt: 180000, targetSize: 80000, protectRecent: 20000 },
};

const qwopusRuntime: RuntimeProviderModel = {
  modelId: 'openai-compatible-qwopus',
  modelString: 'qwopus-reasoner-v1',
  capabilities: {
    streaming: true,
    tools: true,
    vision: false,
    thinking: true,
  },
  context: { maxTokens: 128000, maxOutputTokens: 32768 },
};

describe('reconcileWithRuntimeModel', () => {
  it('propagates runtime provider/model identifiers', () => {
    const out = reconcileWithRuntimeModel(claudeNominal, {
      model: qwopusRuntime,
      providerType: 'openai-compatible',
    });

    expect(out.provider).toBe('openai-compatible');
    expect(out.modelId).toBe('openai-compatible-qwopus');
    expect(out.modelString).toBe('qwopus-reasoner-v1');
  });

  it('replaces nominal capabilities with runtime capabilities', () => {
    const out = reconcileWithRuntimeModel(claudeNominal, {
      model: qwopusRuntime,
      providerType: 'openai-compatible',
    });

    expect(out.capabilities.vision).toBe(false); // Claude had true, Qwopus has false
    expect(out.capabilities.thinking).toBe(true);
  });

  it('replaces nominal context with runtime context (drives compaction sizing)', () => {
    const out = reconcileWithRuntimeModel(claudeNominal, {
      model: qwopusRuntime,
      providerType: 'openai-compatible',
    });

    expect(out.context.maxTokens).toBe(128000);
    expect(out.context.maxOutputTokens).toBe(32768);
  });

  it('without user override, maxTokens snaps to runtime capability', () => {
    // This is the Rai bug: nominal maxTokens=8192 (Claude default), but
    // Qwopus can do 32768. With no explicit user preference, we let the
    // runtime model use its full budget — the nominal 8192 is a constraint
    // on a *different* model and must not cap Qwopus.
    const out = reconcileWithRuntimeModel(claudeNominal, {
      model: qwopusRuntime,
      providerType: 'openai-compatible',
    });

    expect(out.maxTokens).toBe(32768);
  });

  it('with user override below capability, respects user preference', () => {
    const configWithOverride: EffectiveLLMConfig = {
      ...claudeNominal,
      maxTokens: 4096,
      maxTokensUserOverride: 4096, // operator explicitly wants short responses
    };

    const out = reconcileWithRuntimeModel(configWithOverride, {
      model: qwopusRuntime,
      providerType: 'openai-compatible',
    });

    // MIN(4096 preference, 32768 capability) = 4096
    expect(out.maxTokens).toBe(4096);
  });

  it('with user override above capability, caps at capability', () => {
    const configWithOverride: EffectiveLLMConfig = {
      ...claudeNominal,
      maxTokens: 64000,
      maxTokensUserOverride: 64000, // operator wants 64k, model only does 32k
    };

    const out = reconcileWithRuntimeModel(configWithOverride, {
      model: qwopusRuntime,
      providerType: 'openai-compatible',
    });

    // MIN(64000 preference, 32768 capability) = 32768
    expect(out.maxTokens).toBe(32768);
  });

  it('preserves compaction policy from nominal config (operator choice)', () => {
    const out = reconcileWithRuntimeModel(claudeNominal, {
      model: qwopusRuntime,
      providerType: 'openai-compatible',
    });

    expect(out.compaction).toEqual(claudeNominal.compaction);
  });

  it('merges provider-level config (baseUrl, routingStrategy, etc.)', () => {
    const configWithPrior: EffectiveLLMConfig = {
      ...claudeNominal,
      providerConfig: { routingStrategy: 'cheapest' },
    };

    const out = reconcileWithRuntimeModel(configWithPrior, {
      model: qwopusRuntime,
      providerType: 'openai-compatible',
      providerConfig: { baseUrl: 'https://tower.example.com' },
    });

    expect(out.providerConfig).toEqual({
      routingStrategy: 'cheapest',
      baseUrl: 'https://tower.example.com',
    });
  });

  it('applies universally — Anthropic core over OpenRouter runtime', () => {
    // Example: Claude-based core routed through OpenRouter to Sonnet-via-Anthropic.
    const openrouterRuntime: RuntimeProviderModel = {
      modelId: 'openrouter-claude-sonnet',
      modelString: 'anthropic/claude-sonnet-4-5',
      capabilities: { streaming: true, tools: true, vision: true, thinking: true },
      context: { maxTokens: 200000, maxOutputTokens: 16384 }, // OpenRouter may advertise different ceiling
    };

    const out = reconcileWithRuntimeModel(claudeNominal, {
      model: openrouterRuntime,
      providerType: 'openrouter',
    });

    expect(out.provider).toBe('openrouter');
    expect(out.maxTokens).toBe(16384); // runtime wins
    expect(out.context.maxOutputTokens).toBe(16384);
  });

  it('applies universally — Anthropic core over Ollama runtime', () => {
    const ollamaRuntime: RuntimeProviderModel = {
      modelId: 'ollama-qwen2.5-coder-32b',
      modelString: 'qwen2.5-coder:32b',
      capabilities: { streaming: true, tools: true, vision: false, thinking: false },
      context: { maxTokens: 32768, maxOutputTokens: 32768 },
    };

    const out = reconcileWithRuntimeModel(claudeNominal, {
      model: ollamaRuntime,
      providerType: 'ollama',
      providerConfig: { baseUrl: 'http://midgar:11434' },
    });

    expect(out.provider).toBe('ollama');
    expect(out.maxTokens).toBe(32768);
    expect(out.providerConfig?.baseUrl).toBe('http://midgar:11434');
    expect(out.capabilities.vision).toBe(false);
  });

  it('leaves nominal values intact when runtime model has no context', () => {
    // Edge case: some provider types synthesize lightweight models without
    // a full context window. We preserve nominal values in that case.
    const contextlessRuntime: RuntimeProviderModel = {
      modelId: 'ephemeral-model',
      modelString: 'ephemeral',
      capabilities: { streaming: true, tools: false, vision: false, thinking: false },
      // context: undefined
    };

    const out = reconcileWithRuntimeModel(claudeNominal, {
      model: contextlessRuntime,
      providerType: 'openai-compatible',
    });

    // Provider/model IDs updated, but context + maxTokens stay nominal.
    expect(out.provider).toBe('openai-compatible');
    expect(out.modelString).toBe('ephemeral');
    expect(out.context).toEqual(claudeNominal.context);
    expect(out.maxTokens).toBe(claudeNominal.maxTokens);
  });

  it('does not mutate the input config (pure function)', () => {
    const snapshot = JSON.parse(JSON.stringify(claudeNominal));
    reconcileWithRuntimeModel(claudeNominal, {
      model: qwopusRuntime,
      providerType: 'openai-compatible',
    });
    expect(claudeNominal).toEqual(snapshot);
  });
});
