/**
 * AnthropicLLMAdapter abort wiring test (Phase 2.0 — TER-348).
 *
 * Structural regression test verifying that AnthropicLLMAdapter wires the
 * caller's `AbortSignal` to `stream.controller.abort()`. This guarantees
 * that turn-level cancellation in higher layers (ConversationManager) reaches
 * the Anthropic SDK's underlying fetch.
 *
 * Runtime end-to-end behavior (signal abort → stream stops <500ms) is
 * covered in Phase 2.2 with a MockLLM harness. Here we assert the wiring
 * is present in source to prevent regression.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(import.meta.dir, 'AnthropicLLMAdapter.ts'),
  'utf-8',
);

describe('AnthropicLLMAdapter abort wiring', () => {
  it('reads `signal` from StreamMessageOptions', () => {
    // The adapter must extract `signal` from the options object.
    expect(source).toMatch(/signal[\s,}]/);
  });

  it("registers an 'abort' listener on the caller signal", () => {
    // Pattern: signal.addEventListener('abort', ...) — the canonical wire-up.
    expect(source).toContain("addEventListener('abort'");
  });

  it("calls stream.controller.abort() inside the listener", () => {
    // The listener must invoke the Anthropic SDK's stream controller abort
    // so the underlying fetch is cancelled.
    expect(source).toContain('stream.controller.abort()');
  });

  it('logs a warning on abort for diagnostic traceability', () => {
    // Warn-log on abort so production telemetry shows turn cancellation
    // reached the LLM layer.
    expect(source).toMatch(/log\.(warn|info)\([^)]*Abort/i);
  });
});

describe('AnthropicLLMAdapter system-prompt cache split (PR #375 #7)', () => {
  it('splits the system prompt via splitSystemPromptForCache', () => {
    expect(source).toContain('splitSystemPromptForCache(');
  });

  it('adds cache_control only to the stable block', () => {
    // The stable block carries cache_control; the volatile block is pushed
    // without it so per-request content never invalidates the cached prefix.
    expect(source).toMatch(/text:\s*stable[\s\S]*?cache_control/);
    expect(source).toMatch(/systemBlocks\.push\(\{\s*type:\s*'text',\s*text:\s*volatile\s*\}\)/);
  });
});
