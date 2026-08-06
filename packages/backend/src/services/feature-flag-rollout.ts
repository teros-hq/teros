/**
 * Deterministic percentage bucketing for feature-flag rollouts.
 *
 * A rollout exposes a flag value to the first `percentage` buckets [0, percentage).
 * `stableBucket(id, key)` maps an identity (e.g. an agent's ownerId) to a stable
 * bucket in 0..99 so that:
 *
 * - **Deterministic**: same (id, key) → same bucket, always (no Date/random).
 * - **Stable**: the bucket does not depend on the current percentage or any
 *   external state — only on the id and the flag key.
 * - **Salted by key**: different flags spread the same ids differently, so an id
 *   is not correlated across experiments (being in `core.agent`'s rollout tells
 *   you nothing about `core.super-agent`'s).
 * - **Monotonic**: raising `percentage` from P1 to P2 only ADDS ids (everyone with
 *   bucket < P1 still has bucket < P2); it never reshuffles who is in.
 */

import { createHash } from 'node:crypto';

/**
 * Map `id` to a stable bucket in [0, 99] for the given flag `key`.
 *
 * Implementation: sha256(`${key}:${id}`), take the first 4 bytes as a big-endian
 * uint32, modulo 100. The modulo bias over 2^32 is negligible (< 1e-7).
 */
export function stableBucket(id: string, key: string): number {
  const digest = createHash('sha256').update(`${key}:${id}`).digest();
  // First 4 bytes, big-endian, as an unsigned 32-bit integer.
  const n = digest.readUInt32BE(0);
  return n % 100;
}

/**
 * Whether `id` falls inside a rollout of the given `percentage` for `key`.
 * `percentage <= 0` → always false (rollout off); `percentage >= 100` → always true.
 */
export function isInRollout(id: string, key: string, percentage: number): boolean {
  if (percentage <= 0) return false;
  if (percentage >= 100) return true;
  return stableBucket(id, key) < percentage;
}
