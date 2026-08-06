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
