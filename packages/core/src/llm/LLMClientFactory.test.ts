/**
 * LLMClientFactory tests (TER-458).
 *
 * Verifica que cada provider construye el adapter correcto y que FALLA LOUD
 * (throw, no fallback silencioso) ante config incompleta: model ausente y
 * API key ausente. Principio "Fail Fast, Fail Loud" de ENGINEERING-PRINCIPLES.
 *
 * NO se testean los caminos de `anthropic`/`anthropic-oauth` SIN apiKey
 * porque resuelven contra el filesystem (Claude Code CLI creds /
 * hasOAuthTokens) → no deterministas en la máquina del dev. Sus guards de
 * "model required" (antes del filesystem) sí se cubren.
 */

import { describe, expect, it } from 'bun:test';
import { LLMClientFactory } from './LLMClientFactory';
import { AnthropicLLMAdapter } from './AnthropicLLMAdapter';
import { OpenAILLMAdapter } from './OpenAILLMAdapter';
import { OpenAICompatibleLLMAdapter } from './OpenAICompatibleLLMAdapter';
import { OpenRouterLLMAdapter } from './OpenRouterLLMAdapter';
import { GeminiLLMAdapter } from './GeminiLLMAdapter';
import { OllamaLLMAdapter } from './OllamaLLMAdapter';
import { ZhipuLLMAdapter } from './ZhipuLLMAdapter';

const KEY = 'sk-test-key';

// ─────────────────────────────────────────────────────────────────────────────
// Construcción del adapter correcto por provider
// ─────────────────────────────────────────────────────────────────────────────

describe('LLMClientFactory.create — correct adapter per provider', () => {
  it('anthropic → AnthropicLLMAdapter', async () => {
    const client = await LLMClientFactory.create({
      provider: 'anthropic',
      anthropic: { apiKey: KEY, model: 'claude-sonnet-4-5' },
    });
    expect(client).toBeInstanceOf(AnthropicLLMAdapter);
  });

  it('openai → OpenAILLMAdapter', async () => {
    const client = await LLMClientFactory.create({
      provider: 'openai',
      openai: { apiKey: KEY, model: 'gpt-4o' },
    });
    expect(client).toBeInstanceOf(OpenAILLMAdapter);
  });

  it('openrouter → OpenRouterLLMAdapter', async () => {
    const client = await LLMClientFactory.create({
      provider: 'openrouter',
      openrouter: { apiKey: KEY, model: 'anthropic/claude-sonnet-4.5' },
    });
    expect(client).toBeInstanceOf(OpenRouterLLMAdapter);
  });

  it('google → GeminiLLMAdapter', async () => {
    const client = await LLMClientFactory.create({
      provider: 'google',
      google: { apiKey: KEY, model: 'gemini-2.5-pro' },
    });
    expect(client).toBeInstanceOf(GeminiLLMAdapter);
  });

  it('zhipu → ZhipuLLMAdapter', async () => {
    const client = await LLMClientFactory.create({
      provider: 'zhipu',
      zhipu: { apiKey: KEY, model: 'glm-4.6' },
    });
    expect(client).toBeInstanceOf(ZhipuLLMAdapter);
  });

  it('zhipu-coding → ZhipuLLMAdapter (coding endpoint)', async () => {
    const client = await LLMClientFactory.create({
      provider: 'zhipu-coding',
      zhipu: { apiKey: KEY, model: 'glm-4.6' },
    });
    expect(client).toBeInstanceOf(ZhipuLLMAdapter);
  });

  it('ollama → OllamaLLMAdapter (no key, needs baseUrl)', async () => {
    const client = await LLMClientFactory.create({
      provider: 'ollama',
      ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b' },
    });
    expect(client).toBeInstanceOf(OllamaLLMAdapter);
  });

  it('ollama-cloud → OllamaLLMAdapter', async () => {
    const client = await LLMClientFactory.create({
      provider: 'ollama-cloud',
      'ollama-cloud': { apiKey: KEY, model: 'qwen3-coder:480b-cloud' },
    });
    expect(client).toBeInstanceOf(OllamaLLMAdapter);
  });

  it('openai-compatible → OpenAICompatibleLLMAdapter', async () => {
    const client = await LLMClientFactory.create({
      provider: 'openai-compatible',
      'openai-compatible': { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: KEY },
    });
    expect(client).toBeInstanceOf(OpenAICompatibleLLMAdapter);
  });

  it('minimax → AnthropicLLMAdapter (Anthropic-compatible endpoint)', async () => {
    const client = await LLMClientFactory.create({
      provider: 'minimax',
      minimax: { apiKey: KEY, model: 'MiniMax-M2.7' },
    });
    expect(client).toBeInstanceOf(AnthropicLLMAdapter);
  });

  it('teros/cloudflare/fireworks/together → OpenAICompatibleLLMAdapter', async () => {
    const teros = await LLMClientFactory.create({
      provider: 'teros',
      teros: { apiKey: KEY, model: 'accounts/fireworks/models/kimi-k2' },
    });
    expect(teros).toBeInstanceOf(OpenAICompatibleLLMAdapter);

    const cf = await LLMClientFactory.create({
      provider: 'cloudflare',
      cloudflare: { apiKey: KEY, accountId: 'acc_1', model: '@cf/moonshotai/kimi' },
    });
    expect(cf).toBeInstanceOf(OpenAICompatibleLLMAdapter);

    const fw = await LLMClientFactory.create({
      provider: 'fireworks',
      fireworks: { apiKey: KEY, model: 'accounts/fireworks/models/kimi-k2' },
    });
    expect(fw).toBeInstanceOf(OpenAICompatibleLLMAdapter);

    const together = await LLMClientFactory.create({
      provider: 'together',
      together: { apiKey: KEY, model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
    });
    expect(together).toBeInstanceOf(OpenAICompatibleLLMAdapter);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail loud — model required
// ─────────────────────────────────────────────────────────────────────────────

describe('LLMClientFactory.create — fails loud on missing model', () => {
  const cases: Array<{ provider: any; payload: any; needle: string }> = [
    { provider: 'anthropic', payload: { anthropic: { apiKey: KEY } }, needle: 'Anthropic model is required' },
    { provider: 'anthropic-oauth', payload: { anthropic: { apiKey: KEY } }, needle: 'Anthropic model is required' },
    { provider: 'openai', payload: { openai: { apiKey: KEY } }, needle: 'OpenAI model is required' },
    { provider: 'openrouter', payload: { openrouter: { apiKey: KEY } }, needle: 'OpenRouter model is required' },
    { provider: 'google', payload: { google: { apiKey: KEY } }, needle: 'Google AI model is required' },
    { provider: 'zhipu', payload: { zhipu: { apiKey: KEY } }, needle: 'Zhipu model is required' },
    { provider: 'ollama', payload: { ollama: { baseUrl: 'http://x' } }, needle: 'Ollama model is required' },
    { provider: 'minimax', payload: { minimax: { apiKey: KEY } }, needle: 'MiniMax model is required' },
    { provider: 'teros', payload: { teros: { apiKey: KEY } }, needle: 'Teros model is required' },
    { provider: 'cloudflare', payload: { cloudflare: { apiKey: KEY, accountId: 'a' } }, needle: 'Cloudflare model is required' },
    { provider: 'fireworks', payload: { fireworks: { apiKey: KEY } }, needle: 'Fireworks model is required' },
    { provider: 'together', payload: { together: { apiKey: KEY } }, needle: 'Together model is required' },
  ];

  for (const c of cases) {
    it(`${c.provider} without model throws "${c.needle}"`, async () => {
      await expect(
        LLMClientFactory.create({ provider: c.provider, ...c.payload } as any),
      ).rejects.toThrow(c.needle);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail loud — API key required (providers WITHOUT filesystem fallback)
// ─────────────────────────────────────────────────────────────────────────────

describe('LLMClientFactory.create — fails loud on missing API key', () => {
  const cases: Array<{ provider: any; payload: any; needle: string }> = [
    { provider: 'openai', payload: { openai: { model: 'gpt-4o' } }, needle: 'No OpenAI API key available' },
    { provider: 'openrouter', payload: { openrouter: { model: 'x/y' } }, needle: 'No OpenRouter API key available' },
    { provider: 'google', payload: { google: { model: 'gemini-2.5-pro' } }, needle: 'No Google AI API key available' },
    { provider: 'zhipu', payload: { zhipu: { model: 'glm-4.6' } }, needle: 'No Zhipu API key available' },
    { provider: 'minimax', payload: { minimax: { model: 'MiniMax-M2.7' } }, needle: 'No MiniMax API key available' },
    { provider: 'teros', payload: { teros: { model: 'm' } }, needle: 'No Teros API key available' },
    { provider: 'cloudflare', payload: { cloudflare: { accountId: 'a', model: 'm' } }, needle: 'No Cloudflare API key available' },
    { provider: 'fireworks', payload: { fireworks: { model: 'm' } }, needle: 'No Fireworks AI API key available' },
    { provider: 'together', payload: { together: { model: 'm' } }, needle: 'No Together AI API key available' },
    { provider: 'ollama-cloud', payload: { 'ollama-cloud': { model: 'm' } }, needle: 'Ollama Cloud API key is required' },
  ];

  for (const c of cases) {
    it(`${c.provider} without API key throws "${c.needle}"`, async () => {
      await expect(
        LLMClientFactory.create({ provider: c.provider, ...c.payload } as any),
      ).rejects.toThrow(c.needle);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail loud — required structural fields + unknown provider
// ─────────────────────────────────────────────────────────────────────────────

describe('LLMClientFactory.create — structural guards', () => {
  it('ollama without baseUrl throws', async () => {
    await expect(
      LLMClientFactory.create({ provider: 'ollama', ollama: { model: 'm' } } as any),
    ).rejects.toThrow('Ollama baseUrl is required');
  });

  it('cloudflare without accountId throws', async () => {
    await expect(
      LLMClientFactory.create({
        provider: 'cloudflare',
        cloudflare: { apiKey: KEY, model: 'm' },
      } as any),
    ).rejects.toThrow('Cloudflare accountId is required');
  });

  it('openai-compatible without baseUrl throws', async () => {
    await expect(
      LLMClientFactory.create({
        provider: 'openai-compatible',
        'openai-compatible': { model: 'm' },
      } as any),
    ).rejects.toThrow('openai-compatible: baseUrl is required');
  });

  it('openai-compatible without model throws', async () => {
    await expect(
      LLMClientFactory.create({
        provider: 'openai-compatible',
        'openai-compatible': { baseUrl: 'https://x/v1' },
      } as any),
    ).rejects.toThrow('openai-compatible: model is required');
  });

  it('openai-codex-oauth without access token throws loud', async () => {
    await expect(
      LLMClientFactory.create({
        provider: 'openai-codex-oauth',
        'openai-codex-oauth': { model: 'gpt-5', tokens: {} as any },
      } as any),
    ).rejects.toThrow('No OAuth tokens found for OpenAI Codex');
  });

  it('unknown provider throws "Unknown LLM provider"', async () => {
    await expect(
      LLMClientFactory.create({ provider: 'made-up' as any }),
    ).rejects.toThrow('Unknown LLM provider: made-up');
  });
});
