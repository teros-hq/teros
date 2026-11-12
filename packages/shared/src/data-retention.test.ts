/**
 * Contract — data-retention classification (PROVIDER_RETENTION + resolveRetention).
 *
 * Guards the invariants that matter:
 *   - every provider in the model catalog is classified (no silent `unknown`);
 *   - the zhipu China nuance flips the tier to `trains`;
 *   - unknown providers fail safe to `retains` (never `zdr`);
 *   - the consumer-OAuth providers are `trains` (the headline risk of the feature);
 *   - the classification has been re-verified recently (policies drift).
 */

import { describe, expect, it } from 'bun:test';
import {
  PROVIDER_RETENTION,
  RETENTION_VERIFIED_AT,
  resolveRetention,
  retentionNeedsNotice,
  type RetentionTier,
} from './data-retention.js';

// Mirror of every `provider` value in the model catalog
// (packages/backend/src/types/database.ts → Model.provider). Kept here so a new
// provider that ships without a classification fails this test loudly. The
// backend list-models test additionally checks the RUNTIME catalog
// (MODEL_DEFINITIONS) against this map.
const CATALOG_PROVIDERS = [
  'anthropic',
  'anthropic-oauth',
  'openai',
  'openai-codex-oauth',
  'openrouter',
  'google',
  'groq',
  'zhipu',
  'zhipu-coding',
  'ollama',
  'ollama-cloud',
  'openai-compatible',
  'minimax',
  'teros',
  'cloudflare',
  'fireworks',
  'together',
] as const;

describe('PROVIDER_RETENTION coverage', () => {
  it('classifies every catalog provider except the generic openai-compatible passthrough', () => {
    // `openai-compatible` is an arbitrary user-supplied endpoint (Tower, LM Studio,
    // vLLM…) with no knowable policy → intentionally falls through to UNKNOWN.
    const missing = CATALOG_PROVIDERS.filter(
      (p) => p !== 'openai-compatible' && !(p in PROVIDER_RETENTION),
    );
    expect(missing).toEqual([]);
  });

  it('uses only valid tiers and a non-empty notice slug (not a full i18n path)', () => {
    const valid: RetentionTier[] = ['zdr', 'retains', 'trains'];
    for (const info of Object.values(PROVIDER_RETENTION)) {
      expect(valid).toContain(info.tier);
      expect(info.noticeSlug.length).toBeGreaterThan(0);
      // The shared contract must NOT carry the frontend i18n namespace.
      expect(info.noticeSlug.includes('.')).toBe(false);
    }
  });
});

describe('resolveRetention — tiers', () => {
  it('marks the truly zero-retention providers as zdr', () => {
    for (const p of ['teros', 'fireworks', 'ollama', 'ollama-cloud', 'cloudflare', 'together', 'helmcode']) {
      // `together` is zdr via the account-level ZDR opt-in (enabled for our org,
      // TER-646) — this is what arms the teros→Together failover.
      expect(resolveRetention(p).tier).toBe('zdr');
    }
  });

  it('marks paid APIs and configurable providers as retains (incl. groq — abuse logs 30d)', () => {
    for (const p of ['anthropic', 'openai', 'groq', 'openrouter', 'zhipu', 'zhipu-coding', 'google']) {
      expect(resolveRetention(p).tier).toBe('retains');
    }
  });

  it('marks consumer subscriptions and opaque providers as trains (the headline risk)', () => {
    for (const p of ['anthropic-oauth', 'openai-codex-oauth', 'minimax']) {
      expect(resolveRetention(p).tier).toBe('trains');
    }
  });
});

describe('resolveRetention — helmcode keeps its EU-specific notice', () => {
  // Helmcode is ZDR *and* EU-hosted. It must NOT collapse into the generic `zdr`
  // slug: that copy says nothing is stored, but never says WHERE the data lives,
  // so the EU-residency half of the claim would silently stop being shown.
  it('uses its own slug, not the generic zdr one', () => {
    const info = resolveRetention('helmcode');
    expect(info.tier).toBe('zdr');
    expect(info.noticeSlug).toBe('helmcode');
    expect(info.noticeSlug).not.toBe('zdr');
  });

  it('does not gate the choice (zdr needs no notice)', () => {
    expect(retentionNeedsNotice(resolveRetention('helmcode'))).toBe(false);
  });
});

describe('resolveRetention — config nuances', () => {
  it('keeps zhipu at retains on the default (z.ai) endpoint', () => {
    expect(resolveRetention('zhipu').tier).toBe('retains');
    expect(resolveRetention('zhipu', { useChina: false }).tier).toBe('retains');
    expect(resolveRetention('zhipu-coding', {}).tier).toBe('retains');
  });

  it('flips zhipu to trains when routed to the China endpoint', () => {
    expect(resolveRetention('zhipu', { useChina: true }).tier).toBe('trains');
    expect(resolveRetention('zhipu-coding', { useChina: true }).tier).toBe('trains');
    expect(resolveRetention('zhipu', { useChina: true }).noticeSlug).toBe('zhipuChina');
  });

  it('does not apply the China nuance to non-zhipu providers', () => {
    // A stray useChina flag on another provider must not change its tier.
    expect(resolveRetention('openai', { useChina: true }).tier).toBe('retains');
  });
});

describe('resolveRetention — unknown providers fail safe', () => {
  it('returns retains (never zdr) for an unclassified provider', () => {
    const info = resolveRetention('some-future-provider');
    expect(info.tier).toBe('retains');
    expect(info.tier).not.toBe('zdr');
    expect(info.noticeSlug).toBe('unknown');
  });

  it('treats the generic openai-compatible passthrough as unknown', () => {
    expect(resolveRetention('openai-compatible').noticeSlug).toBe('unknown');
  });
});

describe('retentionNeedsNotice', () => {
  it('is false only for zdr', () => {
    expect(retentionNeedsNotice(resolveRetention('teros'))).toBe(false);
    expect(retentionNeedsNotice(resolveRetention('ollama'))).toBe(false);
    expect(retentionNeedsNotice(resolveRetention('anthropic'))).toBe(true);
    expect(retentionNeedsNotice(resolveRetention('anthropic-oauth'))).toBe(true);
  });
});

describe('resolveRetention — model-level ZDR override (providerConfig.zdr)', () => {
  // A model marked `providerConfig.zdr: true` in the catalog is ZDR regardless
  // of the provider's default posture (local Ollama models, enterprise-ZDR
  // endpoints). `false`/absent never DOWNGRADES a ZDR provider.
  it('forces zdr on a retains-tier provider', () => {
    expect(resolveRetention('openai', { zdr: true }).tier).toBe('zdr');
    expect(resolveRetention('google', { zdr: true }).tier).toBe('zdr');
  });

  it('forces zdr even on a trains-tier provider (enterprise agreement)', () => {
    expect(resolveRetention('anthropic-oauth', { zdr: true }).tier).toBe('zdr');
  });

  it('does not downgrade a zdr provider when the flag is false or absent', () => {
    expect(resolveRetention('ollama', { zdr: false }).tier).toBe('zdr');
    expect(resolveRetention('ollama').tier).toBe('zdr');
    expect(resolveRetention('fireworks', { zdr: false }).tier).toBe('zdr');
  });

  it('keeps the provider default for retains/trains when the flag is false', () => {
    expect(resolveRetention('openai', { zdr: false }).tier).toBe('retains');
    expect(resolveRetention('minimax', { zdr: false }).tier).toBe('trains');
  });

  it('zhipu useChina (worse posture) still wins over zdr override order — both are explicit config', () => {
    // useChina routes to the PRC endpoint (trains). If a model ever carried
    // BOTH flags the China routing is the stronger data-flow statement; the
    // resolver checks it first. Pin that precedence so it stays deliberate.
    expect(resolveRetention('zhipu', { useChina: true, zdr: true }).tier).toBe('trains');
  });
});

describe('classification freshness guard', () => {
  // Provider data policies change (Anthropic consumer terms 2025, Gemini terms
  // 2026…). A stale classification ships a FALSE privacy claim silently. This
  // test forces a periodic re-audit: when it goes red, re-verify every provider
  // against current official policy and bump RETENTION_VERIFIED_AT.
  const MAX_AGE_MONTHS = 6;

  it(`was verified within the last ${MAX_AGE_MONTHS} months — re-audit if red`, () => {
    const verified = new Date(`${RETENTION_VERIFIED_AT}T00:00:00Z`);
    expect(Number.isNaN(verified.getTime())).toBe(false);
    const ageMs = Date.now() - verified.getTime();
    const ageMonths = ageMs / (1000 * 60 * 60 * 24 * 30.44);
    expect(ageMonths).toBeLessThan(MAX_AGE_MONTHS);
  });
});
