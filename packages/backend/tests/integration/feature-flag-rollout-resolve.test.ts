/**
 * Integration — FeatureFlagService percentage rollout resolution (TER-412).
 *
 * Runs against a throwaway DB on the local Mongo. Verifies the rollout branch
 * sits in the right spot in the precedence chain (user/workspace/company
 * override > rollout% > default), is deterministic per id, and is off at 0%.
 * Skips silently if Mongo is unreachable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type Db, MongoClient } from 'mongodb';
import { FeatureFlagService } from '../../src/services/feature-flag-service';
import { stableBucket } from '../../src/services/feature-flag-rollout';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const DB_NAME = `teros_test_ffrollout_${Date.now()}`;
const KEY = 'core.super-agent'; // a registered string flag, default 'super-agent'

let client: MongoClient;
let db: Db;
let svc: FeatureFlagService;
let available = false;

beforeAll(async () => {
  try {
    client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 });
    db = client.db(DB_NAME);
    available = true;
  } catch {
    console.warn('[ff-rollout test] Mongo unreachable — skipping');
  }
});

afterAll(async () => {
  if (available) {
    await db.dropDatabase();
    await client.close();
  }
});

beforeEach(async () => {
  if (!available) return;
  await db.collection('feature_flags').deleteMany({});
  await db.collection('feature_flag_overrides').deleteMany({});
  svc = new FeatureFlagService(db);
  await svc.syncRegistry(); // creates core.* flags with their registry defaults
});

describe('FeatureFlagService rollout resolution', () => {
  it('no rollout configured → default, source "default"', async () => {
    if (!available) return;
    const r = await svc.resolveWithSource(KEY, { userId: 'u_1' });
    expect(r?.value).toBe('super-agent');
    expect(r?.source).toBe('default');
  });

  it('percentage 100 → rollout value for everyone, source "rollout"', async () => {
    if (!available) return;
    await svc.setRollout(KEY, 'super-agent-v2', 100);
    for (const userId of ['u_1', 'u_2', 'u_3']) {
      const r = await svc.resolveWithSource(KEY, { userId });
      expect(r?.value).toBe('super-agent-v2');
      expect(r?.source).toBe('rollout');
    }
  });

  it('percentage 0 → default (rollout off, config retained)', async () => {
    if (!available) return;
    await svc.setRollout(KEY, 'super-agent-v2', 0);
    const r = await svc.resolveWithSource(KEY, { userId: 'u_1' });
    expect(r?.value).toBe('super-agent');
    expect(r?.source).toBe('default');
  });

  it('an exact user override WINS over an active rollout', async () => {
    if (!available) return;
    await svc.setRollout(KEY, 'super-agent-v2', 100);
    await svc.setOverride(KEY, 'user', 'u_forced', 'super-agent'); // pin back to stable
    const r = await svc.resolveWithSource(KEY, { userId: 'u_forced' });
    expect(r?.value).toBe('super-agent');
    expect(r?.source).toBe('user_override');
  });

  it('workspace and company overrides also WIN over an active rollout (full precedence)', async () => {
    if (!available) return;
    await svc.setRollout(KEY, 'super-agent-v2', 100);

    // workspace override pins the whole workspace back to stable, beating the 100% rollout.
    await svc.setOverride(KEY, 'workspace', 'work_x', 'super-agent');
    const ws = await svc.resolveWithSource(KEY, { userId: 'u_1', workspaceId: 'work_x' });
    expect(ws?.value).toBe('super-agent');
    expect(ws?.source).toBe('workspace_override');

    // company override (lowest of the three) still beats the rollout.
    await svc.setOverride(KEY, 'company', 'co_x', 'super-agent');
    const co = await svc.resolveWithSource(KEY, { userId: 'u_2', companyId: 'co_x' });
    expect(co?.value).toBe('super-agent');
    expect(co?.source).toBe('company_override');

    // user override outranks a workspace override for the same context (most specific wins).
    await svc.setOverride(KEY, 'user', 'u_3', 'super-agent-v2');
    const both = await svc.resolveWithSource(KEY, { userId: 'u_3', workspaceId: 'work_x' });
    expect(both?.source).toBe('user_override');
  });

  it('no userId in context → never rollout (no bucket id)', async () => {
    if (!available) return;
    await svc.setRollout(KEY, 'super-agent-v2', 100);
    const r = await svc.resolveWithSource(KEY, {});
    expect(r?.value).toBe('super-agent');
    expect(r?.source).toBe('default');
  });

  it('membership at 50% matches stableBucket and is stable across calls', async () => {
    if (!available) return;
    await svc.setRollout(KEY, 'super-agent-v2', 50);
    for (const userId of ['u_a', 'u_b', 'u_c', 'u_d', 'u_e']) {
      const expected = stableBucket(userId, KEY) < 50 ? 'super-agent-v2' : 'super-agent';
      const r1 = await svc.resolve(KEY, { userId });
      const r2 = await svc.resolve(KEY, { userId });
      expect(r1).toBe(expected);
      expect(r2).toBe(expected); // deterministic between calls
    }
  });

  it('clearRollout removes the rollout → back to default', async () => {
    if (!available) return;
    await svc.setRollout(KEY, 'super-agent-v2', 100);
    await svc.clearRollout(KEY);
    const r = await svc.resolveWithSource(KEY, { userId: 'u_1' });
    expect(r?.value).toBe('super-agent');
    expect(r?.source).toBe('default');
  });

  it('CONSISTENCY: resolveAll and resolveAllWithSource agree with resolve under rollout', async () => {
    if (!available) return;
    // The same key resolved through any method must yield the same value for
    // the same context — otherwise featureFlags.get and featureFlags.getAll
    // would disagree mid-rollout (the bug this test pins down).
    await svc.setRollout(KEY, 'super-agent-v2', 50);

    for (const userId of ['u_a', 'u_b', 'u_c', 'u_d', 'u_e', 'u_f']) {
      const single = await svc.resolve(KEY, { userId });
      const all = await svc.resolveAll({ userId });
      const allWithSource = await svc.resolveAllWithSource({ userId });

      expect(all[KEY]).toBe(single);
      expect(allWithSource[KEY]?.value).toBe(single);
      // Source must be 'rollout' exactly when the rollout value was served.
      const expectedSource = single === 'super-agent-v2' ? 'rollout' : 'default';
      expect(allWithSource[KEY]?.source).toBe(expectedSource);
    }

    // An exact override beats the rollout in the bulk methods too.
    await svc.setOverride(KEY, 'user', 'u_pinned', 'super-agent');
    const bulk = await svc.resolveAllWithSource({ userId: 'u_pinned' });
    expect(bulk[KEY]?.value).toBe('super-agent');
    expect(bulk[KEY]?.source).toBe('user_override');
  });
});
