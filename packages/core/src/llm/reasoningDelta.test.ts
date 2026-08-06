import { describe, expect, it } from 'vitest';
import { extractReasoningDelta } from './reasoningDelta';

describe('extractReasoningDelta (TER-650)', () => {
  it('extracts the OpenAI-compatible `reasoning_content` field', () => {
    expect(extractReasoningDelta({ reasoning_content: 'let me think' })).toBe('let me think');
  });

  it('extracts the OpenRouter/Ollama `reasoning` field', () => {
    expect(extractReasoningDelta({ reasoning: 'pondering' })).toBe('pondering');
  });

  it('prefers `reasoning_content` when both are present', () => {
    // Deterministic precedence so two providers sending both never diverge.
    expect(extractReasoningDelta({ reasoning_content: 'a', reasoning: 'b' })).toBe('a');
  });

  it('returns "" when the field is an empty string (no false heartbeat)', () => {
    expect(extractReasoningDelta({ reasoning_content: '' })).toBe('');
  });

  it('returns "" when neither field is present', () => {
    expect(extractReasoningDelta({ content: 'visible text' })).toBe('');
  });

  it('returns "" for non-string reasoning values (tolerant boundary parse)', () => {
    expect(extractReasoningDelta({ reasoning_content: 42 })).toBe('');
    expect(extractReasoningDelta({ reasoning: { nested: true } })).toBe('');
  });

  it('returns "" for null / undefined / non-object input', () => {
    expect(extractReasoningDelta(null)).toBe('');
    expect(extractReasoningDelta(undefined)).toBe('');
    expect(extractReasoningDelta('str')).toBe('');
  });
});
