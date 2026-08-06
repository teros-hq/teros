/**
 * Invariant — every LLM adapter implements convertMessages (TER-452)
 *
 * Each of the parallel adapters must turn MessageWithParts into its provider's
 * payload via `convertMessages`. A new adapter that forgets it (or a rename)
 * would silently send malformed history. This pins the adapter set and asserts
 * each defines convertMessages; adding a 10th adapter forces a test update here
 * (and, by convention, a contract test for it). It also guards the tool-id
 * symmetry on adapters that sanitize: sanitizeToolId must hit ≥2 sites (the
 * tool_use id AND the tool_result id) — sanitizing one side only breaks pairing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const LLM_DIR = resolve(__dirname, '../../../packages/core/src/llm');

// Pinned adapters that convert Teros history → a provider payload.
const ADAPTERS = [
  'AnthropicLLMAdapter.ts',
  'AnthropicOAuthAdapter.ts',
  'GeminiLLMAdapter.ts',
  'OllamaLLMAdapter.ts',
  'OpenAICodexOAuthAdapter.ts',
  'OpenAICompatibleLLMAdapter.ts',
  'OpenAILLMAdapter.ts',
  'OpenRouterLLMAdapter.ts',
  'ZhipuLLMAdapter.ts',
];

function adapterFilesWithConvert(): string[] {
  return readdirSync(LLM_DIR)
    .filter((f) => f.endsWith('Adapter.ts'))
    .filter((f) => /convertMessages\s*\(/.test(readFileSync(resolve(LLM_DIR, f), 'utf8')))
    .sort();
}

describe('LLM adapters — convertMessages coverage', () => {
  it('every adapter that converts history is in the pinned set (and vice versa)', () => {
    // Forces a test update + contract test whenever an adapter is added/removed.
    expect(adapterFilesWithConvert()).toEqual([...ADAPTERS].sort());
  });

  it('each pinned adapter actually defines convertMessages', () => {
    for (const f of ADAPTERS) {
      const src = readFileSync(resolve(LLM_DIR, f), 'utf8');
      expect(/convertMessages\s*\(/.test(src)).toBe(true);
    }
  });

  it('adapters that sanitize tool ids apply it on both emission sites (symmetry)', () => {
    for (const f of ADAPTERS) {
      const src = readFileSync(resolve(LLM_DIR, f), 'utf8');
      const defines = /function sanitizeToolId|sanitizeToolId\s*=/.test(src);
      if (!defines) continue;
      const uses = (src.match(/sanitizeToolId\(/g) ?? []).length;
      // The definition counts as 1; real usage on both the tool_use id and the
      // tool_result id means ≥3 total occurrences. One-sided sanitizing breaks
      // the use↔result id match → provider 400.
      expect(uses).toBeGreaterThanOrEqual(3);
    }
  });
});
