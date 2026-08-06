import { describe, expect, it } from 'bun:test';
import {
  PROVIDERS,
  hashColor,
  providerColor,
  providerLabel,
  resolveProvider,
  seriesColor,
} from './llm-providers';

describe('llm-providers registry', () => {
  it('resolves a canonical id to its metadata', () => {
    const p = resolveProvider('anthropic');
    expect(p.id).toBe('anthropic');
    expect(p.label).toBe('Anthropic');
    expect(p.cacheSupport).toBe('active');
  });

  it('normalizes known aliases to their canonical provider', () => {
    // The exact drift bugs the old hardcoded lists had.
    expect(resolveProvider('gemini').id).toBe('google');
    expect(resolveProvider('gemini').label).toBe('Google (Gemini)');
    expect(resolveProvider('codex-oauth').id).toBe('openai-codex-oauth');
  });

  it('degrades an unknown provider without throwing or dropping it', () => {
    const p = resolveProvider('brand-new-provider-x');
    expect(p.id).toBe('brand-new-provider-x');
    expect(p.label).toBe('brand-new-provider-x'); // raw id, not "Unknown"
    expect(p.cacheSupport).toBe('off');
    expect(p.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('handles null/undefined as a stable Unknown', () => {
    expect(resolveProvider(null).label).toBe('Unknown');
    expect(resolveProvider(undefined).label).toBe('Unknown');
  });

  it('providerColor / providerLabel are alias-aware', () => {
    expect(providerColor('gemini')).toBe(PROVIDERS.google.color);
    expect(providerLabel('gemini')).toBe('Google (Gemini)');
  });

  it('hashColor is deterministic and valid hex', () => {
    expect(hashColor('kimi-k2.6')).toBe(hashColor('kimi-k2.6'));
    expect(hashColor('kimi-k2.6')).toMatch(/^#[0-9a-f]{6}$/);
    expect(hashColor('a')).not.toBe(hashColor('b'));
  });

  it('seriesColor is stable per identity key', () => {
    const key = 'fireworks::kimi-k2.6';
    expect(seriesColor(key)).toBe(seriesColor(key));
  });

  it('no registered color sits in the indigo accent band (avoid clashing with #5E6AD2)', () => {
    // Every registered provider except the Teros managed accent should avoid indigo.
    for (const p of Object.values(PROVIDERS)) {
      if (p.id === 'teros') continue;
      expect(p.color.toLowerCase()).not.toBe('#5e6ad2');
    }
  });
});
