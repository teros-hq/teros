/**
 * Invariant — every LLM streaming adapter routes reasoning/thinking to
 * `onThinking` (TER-650).
 *
 * The turn's stall watchdog aborts a stream that goes silent for the inter-token
 * window. A reasoning / extended-thinking model can emit thinking deltas for a
 * long time before any visible text or tool token — if an adapter drops those
 * deltas on the floor instead of forwarding them to `onThinking` (which
 * TurnDriver maps to the watchdog's progress signal), a legitimate long
 * reasoning block reads as a frozen socket and the turn is wrongly killed as a
 * timeout. That was the H2 regression risk introduced by the stall watchdog.
 *
 * This pins the adapter set and asserts each references `onThinking`, so a new
 * adapter (or a refactor that drops the wiring) fails the build until the
 * heartbeat is restored — the error is impossible by construction rather than
 * caught by review. The behavioural assertion (a thinking-only stream keeps the
 * turn alive) lives in TurnDriver's tests; this guards the wiring exists at all.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'bun:test';

const LLM_DIR = resolve(__dirname, '../../../packages/core/src/llm');

// Pinned streaming adapters — must match adapters-convert-messages-coverage.
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

function streamingAdapterFiles(): string[] {
  return readdirSync(LLM_DIR)
    .filter((f) => f.endsWith('Adapter.ts'))
    .filter((f) => /streamMessage\s*\(/.test(readFileSync(resolve(LLM_DIR, f), 'utf8')))
    .sort();
}

describe('LLM adapters — thinking heartbeat coverage', () => {
  it('the pinned set matches the streaming adapters on disk (add/remove forces update)', () => {
    expect(streamingAdapterFiles()).toEqual([...ADAPTERS].sort());
  });

  it('every streaming adapter forwards reasoning/thinking to onThinking', () => {
    const missing: string[] = [];
    for (const f of ADAPTERS) {
      const src = readFileSync(resolve(LLM_DIR, f), 'utf8');
      // A real call: `callbacks?.onThinking?.(` (a bare mention in a comment
      // does not count — we require the invocation).
      if (!/onThinking\?\.\(/.test(src)) missing.push(f);
    }
    // Any adapter here would silently kill long reasoning turns as timeouts.
    expect(missing).toEqual([]);
  });
});
