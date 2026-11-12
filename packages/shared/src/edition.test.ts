/**
 * Contract — Teros edition gating (TER-EDITION).
 *
 * Guards the invariants that matter:
 *   - the default edition is self-hosted (an OSS user who never sets the env
 *     var gets the full experience, local Ollama included);
 *   - 'cloud' is the only value that turns the gate on (typos fail safe to
 *     self-hosted, with a warning — never a crash);
 *   - 'ollama' (local daemon) is the self-hosted-only provider type;
 *   - 'ollama-cloud' is allowed in EVERY edition (the supported Ollama path
 *     in cloud);
 *   - every other provider type is edition-insensitive.
 */

import { describe, expect, it } from 'bun:test';
import {
  isCloudEdition,
  isProviderTypeAllowedInEdition,
  isSelfHostedOnlyProviderType,
  resolveTerosEdition,
  SELF_HOSTED_ONLY_PROVIDER_TYPES,
  TEROS_EDITION,
  type TerosEdition,
} from './edition.js';

describe('resolveTerosEdition', () => {
  it('defaults to self-hosted when the env var is unset', () => {
    expect(resolveTerosEdition(undefined)).toBe('self-hosted');
    expect(resolveTerosEdition('')).toBe('self-hosted');
  });

  it('accepts explicit self-hosted spellings', () => {
    expect(resolveTerosEdition('self-hosted')).toBe('self-hosted');
    expect(resolveTerosEdition('selfhosted')).toBe('self-hosted');
    expect(resolveTerosEdition('oss')).toBe('self-hosted');
  });

  it('accepts cloud, case-insensitive and trimmed', () => {
    expect(resolveTerosEdition('cloud')).toBe('cloud');
    expect(resolveTerosEdition('  CLOUD  ')).toBe('cloud');
  });

  it('fails safe to self-hosted on unknown values (warn, never crash)', () => {
    expect(resolveTerosEdition('production')).toBe('self-hosted');
    expect(resolveTerosEdition('cluod')).toBe('self-hosted');
  });
});

describe('SELF_HOSTED_ONLY_PROVIDER_TYPES', () => {
  it('contains exactly the local ollama provider', () => {
    expect([...SELF_HOSTED_ONLY_PROVIDER_TYPES]).toEqual(['ollama']);
  });

  it('does NOT contain ollama-cloud — cloud is the supported Ollama path everywhere', () => {
    expect(SELF_HOSTED_ONLY_PROVIDER_TYPES).not.toContain('ollama-cloud');
  });
});

describe('isSelfHostedOnlyProviderType', () => {
  it('flags only ollama', () => {
    expect(isSelfHostedOnlyProviderType('ollama')).toBe(true);
    expect(isSelfHostedOnlyProviderType('ollama-cloud')).toBe(false);
    expect(isSelfHostedOnlyProviderType('anthropic')).toBe(false);
  });
});

describe('isProviderTypeAllowedInEdition', () => {
  // The module-level TEROS_EDITION is frozen at import time from the real env,
  // so these assertions hold for the CURRENT process edition; the
  // edition-dependent matrix is covered indirectly by resolveTerosEdition
  // (the only input that can change it) plus the invariant below.
  const cloud = resolveTerosEdition('cloud') === 'cloud';
  void cloud;

  it('never allows ollama (local) when the process edition is cloud', () => {
    if (TEROS_EDITION === 'cloud') {
      expect(isProviderTypeAllowedInEdition('ollama')).toBe(false);
    } else {
      expect(isProviderTypeAllowedInEdition('ollama')).toBe(true);
    }
  });

  it('allows ollama-cloud in every edition', () => {
    expect(isProviderTypeAllowedInEdition('ollama-cloud')).toBe(true);
  });

  it('allows every other provider type regardless of edition', () => {
    for (const t of ['anthropic', 'openai', 'google', 'zhipu', 'teros', 'openai-compatible', 'helmcode']) {
      expect(isProviderTypeAllowedInEdition(t)).toBe(true);
    }
  });

  it('types: edition is one of the two known values', () => {
    const editions: TerosEdition[] = ['self-hosted', 'cloud'];
    expect(editions).toContain(TEROS_EDITION);
  });
});

describe('isCloudEdition', () => {
  it('agrees with TEROS_EDITION', () => {
    expect(isCloudEdition()).toBe(TEROS_EDITION === 'cloud');
  });
});
