/**
 * token-counter tests (TER-458).
 *
 * Función pura que alimenta facturación + UI. El contrato CRÍTICO:
 * estimateCostUsd devuelve `null` (NO 0) cuando no hay pricing — un 0 le
 * mentiría al usuario diciendo "gratis". Cubre encodingForProvider (BPE por
 * familia), countTokensForProvider y resolveModelEntry (vía estimateCostUsd:
 * match directo, lowercase, substring, y los fallos).
 *
 * Valores de pricing anclados a ai-tokenizer 1.x (verificados con probe):
 *   anthropic/claude-3-haiku → input 2.5e-7, output 1.25e-6,
 *   input_cache_read 3e-8, input_cache_write 3e-7  ($/token).
 */

import { describe, expect, it } from 'bun:test';
import {
  countTokensForProvider,
  encodingForProvider,
  estimateCostBreakdownUsd,
  estimateCostUsd,
} from './token-counter';

// ─────────────────────────────────────────────────────────────────────────────
// encodingForProvider — mapeo provider → BPE
// ─────────────────────────────────────────────────────────────────────────────

describe('encodingForProvider', () => {
  it('anthropic family → claude encoding', () => {
    expect(encodingForProvider('anthropic')).toBe('claude');
    expect(encodingForProvider('anthropic-oauth')).toBe('claude');
  });

  it('openai / codex-oauth / gemini → o200k_base', () => {
    expect(encodingForProvider('openai')).toBe('o200k_base');
    expect(encodingForProvider('codex-oauth')).toBe('o200k_base');
    expect(encodingForProvider('gemini')).toBe('o200k_base');
  });

  it('canonical aliases openai-codex-oauth / google → o200k_base (GAP 3a)', () => {
    // Los ids canónicos que persiste agentConfig.llm.provider — antes caían al
    // fallback cl100k porque la función chequeaba sólo los alias legacy.
    expect(encodingForProvider('openai-codex-oauth')).toBe('o200k_base');
    expect(encodingForProvider('google')).toBe('o200k_base');
  });

  it('everything else (incl. undefined) → cl100k_base fallback', () => {
    expect(encodingForProvider('openrouter')).toBe('cl100k_base');
    expect(encodingForProvider('ollama')).toBe('cl100k_base');
    expect(encodingForProvider('zhipu')).toBe('cl100k_base');
    expect(encodingForProvider('teros')).toBe('cl100k_base');
    expect(encodingForProvider(undefined)).toBe('cl100k_base');
    expect(encodingForProvider('made-up-provider')).toBe('cl100k_base');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// countTokensForProvider
// ─────────────────────────────────────────────────────────────────────────────

describe('countTokensForProvider', () => {
  it('empty / undefined / null → 0 (preserves the estimateTokens contract)', () => {
    expect(countTokensForProvider('')).toBe(0);
    expect(countTokensForProvider(undefined)).toBe(0);
    expect(countTokensForProvider(undefined, 'anthropic')).toBe(0);
  });

  it('counts a known string with the claude BPE (verified value)', () => {
    expect(countTokensForProvider('hello world', 'anthropic')).toBe(2);
  });

  it('BPE compresses repeated chars far below chars/4', () => {
    // 40 x's → 2 tokens con BPE (chars/4 daría 10).
    expect(countTokensForProvider('x'.repeat(40), 'anthropic')).toBe(2);
  });

  it('count is a positive integer for non-trivial text', () => {
    const n = countTokensForProvider('The quick brown fox jumps over the lazy dog', 'openai');
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });

  it('undefined provider still counts (cl100k fallback), not 0 for real text', () => {
    expect(countTokensForProvider('hello world')).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateCostUsd — el contrato null-NO-0
// ─────────────────────────────────────────────────────────────────────────────

describe('estimateCostUsd — null when no pricing (NOT 0)', () => {
  it('returns null when provider is missing', () => {
    expect(estimateCostUsd({ modelId: 'claude-3-haiku', inputTokens: 1000, outputTokens: 0 })).toBeNull();
  });

  it('returns null when modelId is missing', () => {
    expect(estimateCostUsd({ provider: 'anthropic', inputTokens: 1000, outputTokens: 0 })).toBeNull();
  });

  it('returns null for an unknown vendor (openrouter/ollama/etc. — not in the registry map)', () => {
    expect(
      estimateCostUsd({ provider: 'openrouter', modelId: 'deepseek/deepseek-chat', inputTokens: 1000, outputTokens: 0 }),
    ).toBeNull();
  });

  it('returns null for a known vendor but non-existent model (no fuzzy garbage match)', () => {
    expect(
      estimateCostUsd({ provider: 'anthropic', modelId: 'totally-made-up-model-xyz', inputTokens: 1000, outputTokens: 0 }),
    ).toBeNull();
  });

  it('NEVER returns 0 to signal "unknown" — null is the only unknown sentinel', () => {
    const result = estimateCostUsd({ provider: 'made-up', modelId: 'x', inputTokens: 999999, outputTokens: 999999 });
    expect(result).toBeNull();
    expect(result).not.toBe(0);
  });
});

describe('estimateCostUsd — real pricing math (anthropic/claude-3-haiku)', () => {
  const IN = 2.5e-7;
  const OUT = 1.25e-6;
  const CACHE_READ = 3e-8;
  const CACHE_WRITE = 3e-7;

  it('input + output cost (direct model match)', () => {
    const cost = estimateCostUsd({
      provider: 'anthropic',
      modelId: 'claude-3-haiku',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cost).toBeCloseTo(1000 * IN + 500 * OUT, 12);
  });

  it('adds cache read + cache write when present', () => {
    const cost = estimateCostUsd({
      provider: 'anthropic',
      modelId: 'claude-3-haiku',
      inputTokens: 1000,
      outputTokens: 500,
      cachedReadTokens: 2000,
      cachedWriteTokens: 100,
    });
    expect(cost).toBeCloseTo(
      1000 * IN + 500 * OUT + 2000 * CACHE_READ + 100 * CACHE_WRITE,
      12,
    );
  });

  it('zero tokens → zero cost (but a real number, distinct from the null-unknown case)', () => {
    const cost = estimateCostUsd({
      provider: 'anthropic',
      modelId: 'claude-3-haiku',
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBe(0);
    expect(cost).not.toBeNull();
  });

  it('cache tokens default to 0 contribution when omitted', () => {
    const without = estimateCostUsd({
      provider: 'anthropic',
      modelId: 'claude-3-haiku',
      inputTokens: 100,
      outputTokens: 100,
    });
    const withZeroCache = estimateCostUsd({
      provider: 'anthropic',
      modelId: 'claude-3-haiku',
      inputTokens: 100,
      outputTokens: 100,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    });
    expect(without).toBe(withZeroCache);
  });
});

describe('estimateCostUsd — resolveModelEntry matching strategies', () => {
  it('exact vendor/model key match', () => {
    expect(
      estimateCostUsd({ provider: 'anthropic', modelId: 'claude-3-opus', inputTokens: 1, outputTokens: 0 }),
    ).toBeGreaterThan(0);
  });

  it('substring match: a partial modelId resolves to a registry entry', () => {
    // 'claude-opus-4' es substring de la key real 'anthropic/claude-opus-4'.
    const cost = estimateCostUsd({
      provider: 'anthropic',
      modelId: 'claude-opus-4',
      inputTokens: 1000,
      outputTokens: 0,
    });
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });

  it('openai vendor inference resolves gpt-4o pricing', () => {
    expect(
      estimateCostUsd({ provider: 'openai', modelId: 'gpt-4o', inputTokens: 1000, outputTokens: 0 }),
    ).toBeGreaterThan(0);
  });

  it('gemini maps to the google vendor', () => {
    const cost = estimateCostUsd({
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      inputTokens: 1000,
      outputTokens: 0,
    });
    // Si la key existe en el registry, > 0; si no, null. Nunca 0 espurio.
    expect(cost === null || cost > 0).toBe(true);
  });

  // GAP 3a: los ids CANÓNICOS que persiste agentConfig.llm.provider — antes
  // resolvían null pese a tener pricing en el registry. Modelos anclados a
  // entries que EXISTEN en ai-tokenizer (deterministas, no `|| null`).
  it('google (canonical alias of gemini) resolves gemini-2.5-flash pricing', () => {
    const cost = estimateCostUsd({
      provider: 'google',
      modelId: 'gemini-2.5-flash',
      inputTokens: 1000,
      outputTokens: 0,
    });
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });

  it('minimax provider resolves minimax-m2 pricing', () => {
    const cost = estimateCostUsd({
      provider: 'minimax',
      modelId: 'minimax-m2',
      inputTokens: 1000,
      outputTokens: 0,
    });
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });

  it('unverified served models stay null — never a fabricated price', () => {
    // glm-6.0 no tiene precio verificado (ni en ai-tokenizer ni owned) → NO se
    // mapea por aproximación a glm-5/5.2. Honest "—".
    expect(
      estimateCostUsd({ provider: 'zhipu', modelId: 'glm-6.0', inputTokens: 1000, outputTokens: 500 }),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateCostUsd — subscription billing gate (TER-666 / A2.4)
// ─────────────────────────────────────────────────────────────────────────────

describe('estimateCostUsd — subscription providers return null (no phantom per-token cost)', () => {
  it('zhipu-coding (GLM Coding Plan) → null even for a model with an owned rate', () => {
    // glm-5.2 IS priced on the zhipu direct path, but zhipu-coding is a flat plan
    // → no per-token cost. Mutation: dropping the gate prices it → number → red.
    expect(
      estimateCostUsd({ provider: 'zhipu-coding', modelId: 'glm-5.2-coding', inputTokens: 1_000_000, outputTokens: 500_000 }),
    ).toBeNull();
  });

  it('anthropic-oauth (Claude Max) → null even though ai-tokenizer has a claude rate', () => {
    expect(
      estimateCostUsd({ provider: 'anthropic-oauth', modelId: 'claude-3-haiku', inputTokens: 1000, outputTokens: 500 }),
    ).toBeNull();
  });

  it('openai-codex-oauth and its codex-oauth alias → null (ChatGPT plan)', () => {
    expect(
      estimateCostUsd({ provider: 'openai-codex-oauth', modelId: 'gpt-4o', inputTokens: 1000, outputTokens: 0 }),
    ).toBeNull();
    expect(
      estimateCostUsd({ provider: 'codex-oauth', modelId: 'gpt-4o', inputTokens: 1000, outputTokens: 0 }),
    ).toBeNull();
  });

  it('explicit billingType overrides the provider default both ways', () => {
    // usage-billed anthropic-oauth (BYOK-like) → priced.
    expect(
      estimateCostUsd({ provider: 'anthropic-oauth', modelId: 'claude-3-haiku', inputTokens: 1000, outputTokens: 0, billingType: 'usage' }),
    ).toBeGreaterThan(0);
    // subscription-billed anthropic (API key on a flat deal) → null.
    expect(
      estimateCostUsd({ provider: 'anthropic', modelId: 'claude-3-haiku', inputTokens: 1000, outputTokens: 0, billingType: 'subscription' }),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateCostBreakdownUsd — per-component + no reasoning double-charge (A2.1)
// ─────────────────────────────────────────────────────────────────────────────

describe('estimateCostBreakdownUsd', () => {
  const IN = 2.5e-7;
  const OUT = 1.25e-6;
  const CACHE_READ = 3e-8;

  it('splits the cost into components that sum to total', () => {
    const b = estimateCostBreakdownUsd({
      provider: 'anthropic',
      modelId: 'claude-3-haiku',
      inputTokens: 1000,
      outputTokens: 500,
      cachedReadTokens: 2000,
    })!;
    expect(b.input).toBeCloseTo(1000 * IN, 12);
    expect(b.output).toBeCloseTo(500 * OUT, 12);
    expect(b.cacheRead).toBeCloseTo(2000 * CACHE_READ, 12);
    expect(b.total).toBeCloseTo(b.input + b.output + b.cacheRead + b.cacheWrite, 12);
  });

  it('does NOT charge reasoning tokens separately (they are a subset of output)', () => {
    // reasoningTokens is not even an input to the cost — total must match the
    // input+output+cache math with no extra reasoning term. Mutation guard
    // against re-introducing the old double-charge.
    const b = estimateCostBreakdownUsd({
      provider: 'anthropic',
      modelId: 'claude-3-haiku',
      inputTokens: 1000,
      outputTokens: 500,
    })!;
    expect(b.total).toBeCloseTo(1000 * IN + 500 * OUT, 12);
  });

  it('returns null for subscription and unpriced, like estimateCostUsd', () => {
    expect(estimateCostBreakdownUsd({ provider: 'zhipu-coding', modelId: 'glm-5.2-coding', inputTokens: 10, outputTokens: 10 })).toBeNull();
    expect(estimateCostBreakdownUsd({ provider: 'openrouter', modelId: 'x/y', inputTokens: 10, outputTokens: 10 })).toBeNull();
  });
});

describe('estimateCostUsd — Teros-owned hosted pricing (primary source)', () => {
  it('prices the teros managed default (glm-5p2-fast) at the verified GLM 5.2 rate', () => {
    // 1M input + 1M output → $1.40 + $4.40 = $5.80 (era null antes de la tabla owned).
    const cost = estimateCostUsd({
      provider: 'teros',
      modelId: 'teros-glm-5p2-fast',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(5.8, 6);
  });

  it('prices teros/fireworks Kimi with the Fireworks cache-read rate', () => {
    // 1M input + 1M cache-read → $0.95 + $0.19 = $1.14.
    const cost = estimateCostUsd({
      provider: 'teros',
      modelId: 'teros-kimi-k2.6',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedReadTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(1.14, 6);
  });

  it('owned pricing does NOT shadow the ai-tokenizer fallback for anthropic', () => {
    // No hay owned rule para anthropic → sigue resolviendo vía ai-tokenizer (> 0).
    expect(
      estimateCostUsd({ provider: 'anthropic', modelId: 'claude-3-haiku', inputTokens: 1000, outputTokens: 0 }),
    ).toBeGreaterThan(0);
  });
});
