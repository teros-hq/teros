/**
 * Unit tests for splitSystemPromptForCache (TER-618 / PR #375 #7).
 *
 * The helper splits a system prompt into a cacheable stable prefix and a
 * non-cached volatile suffix for cache-aware adapters. It must degrade safely
 * when the endsWith invariant does not hold.
 */

import { describe, expect, it } from 'bun:test';
import { splitSystemPromptForCache } from './ILLMClient';

describe('splitSystemPromptForCache', () => {
  it('slices the volatile suffix off the stable prefix', () => {
    const stable = 'CORE\n\n<project>p</project>';
    const volatile = '\n\n<context>\nCurrent time: X\n</context>';
    const { stable: gotStable, volatile: gotVolatile } = splitSystemPromptForCache(
      stable + volatile,
      volatile,
    );
    expect(gotStable).toBe(stable);
    expect(gotVolatile).toBe(volatile);
  });

  it('returns the whole prompt as stable when no volatile is given', () => {
    const result = splitSystemPromptForCache('WHOLE PROMPT', undefined);
    expect(result.stable).toBe('WHOLE PROMPT');
    expect(result.volatile).toBeUndefined();
  });

  it('degrades safely when volatile is not the suffix (invariant broken)', () => {
    const result = splitSystemPromptForCache('CORE\n\n<context>a</context>', 'DIFFERENT');
    expect(result.stable).toBe('CORE\n\n<context>a</context>');
    expect(result.volatile).toBeUndefined();
  });

  it('yields an empty stable when the prompt is entirely volatile', () => {
    const volatile = '\n\n<context>only</context>';
    const result = splitSystemPromptForCache(volatile, volatile);
    expect(result.stable).toBe('');
    expect(result.volatile).toBe(volatile);
  });

  it('handles an empty system prompt', () => {
    const result = splitSystemPromptForCache('', undefined);
    expect(result.stable).toBe('');
    expect(result.volatile).toBeUndefined();
  });
});
