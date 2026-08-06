/**
 * Adapter-level wiring tests for CTX-007 overflow detection.
 *
 * The shared detector is unit-tested in `context-length-error.test.ts`; here we
 * assert each adapter's error mapper actually FLAGS the error structurally
 * (`context.isContextLengthError`), which is what `TurnDriver.isPromptTooLongError`
 * reads to fire recovery. Errors are built with the REAL OpenAI SDK
 * `APIError.generate` (faithful boundary — the adapters gate on
 * `instanceof OpenAI.APIError`).
 *
 * OpenAICompatible is the default `teros` provider path that was fully broken
 * (no 400/413 branch at all). Anthropic/Zhipu/MiniMax share
 * `LLMError.fromAnthropicError`, covered in `errors/AgentError.test.ts`.
 */

import OpenAI from 'openai';
import { describe, expect, it } from 'bun:test';
import { OpenAICompatibleLLMAdapter } from './OpenAICompatibleLLMAdapter';
import { OpenAILLMAdapter } from './OpenAILLMAdapter';

function apiError(status: number, message: string, code?: string): OpenAI.APIError {
  return OpenAI.APIError.generate(
    status,
    { error: { message, code, type: 'invalid_request_error' } },
    undefined,
    new Headers(),
  ) as OpenAI.APIError;
}

type MappedError = { context: Record<string, any>; userMessage: string; message: string };

describe('OpenAICompatibleLLMAdapter.createLLMError — CTX-007 (default teros provider)', () => {
  const adapter = new OpenAICompatibleLLMAdapter({
    model: 'glm-4.6',
    baseUrl: 'http://localhost:9999',
  });
  const map = (e: unknown): MappedError => (adapter as any).createLLMError(e, {});

  it('400 overflow → flagged + "too long" message + raw preserved', () => {
    const err = map(
      apiError(
        400,
        "This model's maximum context length is 128000 tokens",
        'context_length_exceeded',
      ),
    );
    expect(err.context.isContextLengthError).toBe(true);
    expect(err.userMessage).toContain('too long');
    expect(err.message).toContain('maximum context length');
  });

  it('400 generic (non-overflow) → NOT flagged', () => {
    const err = map(apiError(400, "missing required parameter: 'model'"));
    expect(err.context.isContextLengthError).toBe(false);
  });

  it('413 Payload Too Large → flagged regardless of wording', () => {
    const err = map(apiError(413, 'request entity too large'));
    expect(err.context.isContextLengthError).toBe(true);
  });
});

describe('OpenAILLMAdapter.createLLMError — CTX-007', () => {
  const adapter = new OpenAILLMAdapter({ model: 'gpt-4o', apiKey: 'test-key' });
  const map = (e: unknown): MappedError => (adapter as any).createLLMError(e, {});

  it('400 overflow → flagged', () => {
    const err = map(apiError(400, 'context_length_exceeded', 'context_length_exceeded'));
    expect(err.context.isContextLengthError).toBe(true);
  });

  it('400 generic → NOT flagged', () => {
    const err = map(apiError(400, 'invalid value for temperature'));
    expect(err.context.isContextLengthError).toBe(false);
  });
});
