/**
 * Unit — deterministic percentage bucketing for feature-flag rollouts (TER-412).
 *
 * These invariants are the safety contract of "migrate X% of users": a user's
 * bucket must be stable (their agent can't flip cores), uncorrelated across
 * flags, and monotonic in the percentage (raising % only ADDS users). Each test
 * is written to MORDER: it fails if the hash becomes random, ignores the salt,
 * goes out of range, or depends on the percentage.
 */
import { describe, expect, it } from 'bun:test';
import { isInRollout, stableBucket } from '../../../src/services/feature-flag-rollout';

// Fixed set of ids so the assertions are reproducible.
const IDS = Array.from({ length: 10_000 }, (_, i) => `user_${i.toString(16).padStart(12, '0')}`);

describe('stableBucket', () => {
  it('is deterministic: same (id, key) → same bucket across calls', () => {
    for (const id of ['user_a', 'user_b', 'owner_123']) {
      const first = stableBucket(id, 'core.agent');
      for (let i = 0; i < 5; i++) {
        expect(stableBucket(id, 'core.agent')).toBe(first);
      }
    }
  });

  it('always returns an integer in [0, 99]', () => {
    for (const id of IDS) {
      const b = stableBucket(id, 'core.agent');
      expect(Number.isInteger(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(99);
    }
  });

  it('is salted by key: the same id maps differently across flags (no correlation)', () => {
    // Some ids must land in a different bucket for core.agent vs core.super-agent.
    const differ = IDS.filter(
      (id) => stableBucket(id, 'core.agent') !== stableBucket(id, 'core.super-agent'),
    );
    // If the key were ignored, this would be 0. Expect the vast majority to differ.
    expect(differ.length).toBeGreaterThan(IDS.length * 0.9);
  });

  it('distributes approximately uniformly (±5% over 10k ids)', () => {
    const inFirstHalf = IDS.filter((id) => stableBucket(id, 'core.agent') < 50).length;
    const ratio = inFirstHalf / IDS.length;
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });
});

describe('isInRollout', () => {
  it('percentage 0 → always false; 100 → always true', () => {
    for (const id of ['user_a', 'user_b', 'user_c']) {
      expect(isInRollout(id, 'core.agent', 0)).toBe(false);
      expect(isInRollout(id, 'core.agent', 100)).toBe(true);
    }
  });

  it('is MONOTONIC: raising the percentage only adds ids, never removes', () => {
    const percentages = [0, 5, 10, 25, 50, 75, 100];
    for (let i = 0; i < percentages.length - 1; i++) {
      const p1 = percentages[i];
      const p2 = percentages[i + 1];
      const inP1 = new Set(IDS.filter((id) => isInRollout(id, 'core.agent', p1)));
      const inP2 = new Set(IDS.filter((id) => isInRollout(id, 'core.agent', p2)));
      // Everyone in at p1 must still be in at p2 (p1 < p2).
      for (const id of inP1) {
        expect(inP2.has(id)).toBe(true);
      }
      // And p2 covers at least as many.
      expect(inP2.size).toBeGreaterThanOrEqual(inP1.size);
    }
  });

  it('membership at a percentage matches bucket < percentage exactly', () => {
    for (const id of IDS.slice(0, 200)) {
      const b = stableBucket(id, 'core.agent');
      expect(isInRollout(id, 'core.agent', 30)).toBe(b < 30);
    }
  });

  it('the share inside a 50% rollout is ~50% (±5%)', () => {
    const inside = IDS.filter((id) => isInRollout(id, 'core.agent', 50)).length;
    const ratio = inside / IDS.length;
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });
});
