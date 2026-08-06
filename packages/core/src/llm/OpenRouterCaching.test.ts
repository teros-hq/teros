/**
 * OpenRouterLLMAdapter — cache breakpoint detection (TER-458).
 *
 * Cubre la lógica que decide CUÁNDO y DÓNDE colocar `cache_control`. Un fallo
 * aquí = coste silencioso: o se pierde el cache (paga full input cada turno)
 * o se aplica a un modelo que no lo soporta (error de la API). Métodos puros
 * privados accedidos vía `as any`. El constructor instancia el SDK de forma
 * lazy (sin red), por lo que es seguro en unit.
 */

import { describe, expect, it } from 'bun:test';
import { OpenRouterLLMAdapter } from './OpenRouterLLMAdapter';

function adapter() {
  return new OpenRouterLLMAdapter({ apiKey: 'sk-test', model: 'anthropic/claude-sonnet-4.5' });
}

describe('OpenRouterLLMAdapter — constructor', () => {
  it('throws loud when model is missing', () => {
    expect(() => new OpenRouterLLMAdapter({ apiKey: 'sk-test' } as any)).toThrow(
      'OpenRouterLLMAdapter: model is required',
    );
  });

  it('constructs without performing network I/O', () => {
    expect(() => adapter()).not.toThrow();
  });
});

describe('shouldUseAnthropicCaching', () => {
  const a = adapter();
  const should = (model: string): boolean => (a as any).shouldUseAnthropicCaching(model);

  it('enables caching for OpenRouter-namespaced Claude models', () => {
    expect(should('anthropic/claude-sonnet-4.5')).toBe(true);
    expect(should('anthropic/claude-opus-4-5')).toBe(true);
  });

  it('enables caching for any model string containing "claude"', () => {
    expect(should('claude-3.5-haiku')).toBe(true);
    expect(should('some-proxy/claude-whatever')).toBe(true);
  });

  it('does NOT enable Anthropic caching for non-Claude models', () => {
    expect(should('openai/gpt-4o')).toBe(false);
    expect(should('google/gemini-2.5-pro')).toBe(false);
    expect(should('deepseek/deepseek-chat')).toBe(false);
    expect(should('openrouter/auto')).toBe(false);
  });
});

describe('getMinCacheTokens', () => {
  const a = adapter();
  const minTokens = (model: string): number => (a as any).getMinCacheTokens(model);

  it('Opus 4.5 and Haiku 4.5 require 4096 tokens minimum', () => {
    expect(minTokens('anthropic/claude-opus-4-5')).toBe(4096);
    expect(minTokens('anthropic/claude-haiku-4-5')).toBe(4096);
  });

  it('other Claude models require 1024 tokens minimum', () => {
    expect(minTokens('anthropic/claude-sonnet-4.5')).toBe(1024);
    expect(minTokens('claude-3.5-haiku')).toBe(1024);
    expect(minTokens('anthropic/claude-3-opus')).toBe(1024);
  });
});
