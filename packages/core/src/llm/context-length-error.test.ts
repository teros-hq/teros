/**
 * Tests for the shared context-length detector (CTX-007).
 *
 * This is the single brain every adapter routes through. If it is right,
 * overflow detection is right across all providers, so the pattern coverage and
 * the negative cases are asserted exhaustively here — including the real
 * wordings emitted by Anthropic, OpenAI, Gemini, Zhipu and MiniMax.
 */

import { describe, expect, it } from 'bun:test';
import { CONTEXT_LENGTH_PATTERNS, isContextLengthExceeded } from './context-length-error';

describe('isContextLengthExceeded — status', () => {
  it('413 is overflow unconditionally, even with no message', () => {
    expect(isContextLengthExceeded(413)).toBe(true);
    expect(isContextLengthExceeded(413, '')).toBe(true);
    expect(isContextLengthExceeded(413, 'totally unrelated failure')).toBe(true);
  });

  it('non-413 status does not by itself signal overflow', () => {
    expect(isContextLengthExceeded(400, 'invalid temperature: must be <= 2')).toBe(false);
    expect(isContextLengthExceeded(500, 'internal server error')).toBe(false);
    expect(isContextLengthExceeded(undefined, 'missing required parameter: model')).toBe(false);
  });
});

describe('isContextLengthExceeded — real provider wordings', () => {
  const overflowMessages: Array<[string, string]> = [
    ['Anthropic', 'prompt is too long: 250000 tokens > 200000 maximum'],
    ['OpenAI', "This model's maximum context length is 128000 tokens, however you requested 200000"],
    ['OpenAI code', 'context_length_exceeded'],
    ['Gemini', 'INVALID_ARGUMENT: input token count exceeds the maximum number of tokens allowed'],
    ['Zhipu GLM', "1214: The tokens of your input have exceeded the model's maximum context length"],
    ['MiniMax', "invalid params: total tokens exceed the model's maximum context length limit"],
    ['Fireworks', 'The input is too long. Please reduce the length of the messages'],
    ['Together', 'Input validation error: inputs tokens + max_new_tokens must be <= 8193'],
    ['generic large', 'request too large for this model'],
  ];

  for (const [provider, message] of overflowMessages) {
    it(`detects ${provider} overflow wording`, () => {
      expect(isContextLengthExceeded(400, message)).toBe(true);
    });
  }

  it('is case-insensitive', () => {
    expect(isContextLengthExceeded(400, 'CONTEXT LENGTH EXCEEDED')).toBe(true);
    expect(isContextLengthExceeded(undefined, 'Maximum Context reached')).toBe(true);
  });
});

describe('isContextLengthExceeded — rawError channel', () => {
  it('matches a pattern inside a stringified error object (e.g. OpenAI .code)', () => {
    expect(isContextLengthExceeded(400, 'Bad Request', { code: 'context_length_exceeded' })).toBe(
      true,
    );
  });

  it('matches when rawError is a raw JSON body string', () => {
    expect(
      isContextLengthExceeded(400, '', '{"error":{"message":"maximum context length exceeded"}}'),
    ).toBe(true);
  });

  it('does not throw on a circular rawError object', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => isContextLengthExceeded(400, 'boom', circular)).not.toThrow();
    expect(isContextLengthExceeded(400, 'boom', circular)).toBe(false);
  });
});

describe('isContextLengthExceeded — negatives (bounded false positives)', () => {
  it('generic 400 request errors are NOT overflow', () => {
    expect(isContextLengthExceeded(400, "missing required parameter: 'model'")).toBe(false);
    expect(isContextLengthExceeded(400, 'invalid api key')).toBe(false);
    expect(isContextLengthExceeded(400, 'unsupported value for tools')).toBe(false);
  });

  it('empty / undefined inputs are NOT overflow', () => {
    expect(isContextLengthExceeded(undefined)).toBe(false);
    expect(isContextLengthExceeded(undefined, '')).toBe(false);
    expect(isContextLengthExceeded(400, undefined, undefined)).toBe(false);
  });
});

describe('CONTEXT_LENGTH_PATTERNS', () => {
  it('is a non-empty, all-lowercase list (matching lower-cased input)', () => {
    expect(CONTEXT_LENGTH_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of CONTEXT_LENGTH_PATTERNS) {
      expect(pattern).toBe(pattern.toLowerCase());
    }
  });

  it('every pattern actually triggers detection (no dead entries)', () => {
    for (const pattern of CONTEXT_LENGTH_PATTERNS) {
      expect(isContextLengthExceeded(400, `error: ${pattern} in request`)).toBe(true);
    }
  });
});
