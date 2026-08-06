/**
 * Unit — password lockout state machine (TER-450)
 *
 * `IdentityService.verifyPassword` is the brute-force boundary: 5 failures lock
 * the account for 15 minutes. These tests drive the full state machine against
 * a stateful in-memory `user_identities` collection so the failed-attempt
 * counter persists across calls exactly as it would in Mongo.
 *
 * Regression guarded: after a lockout elapses the counter must reset, otherwise
 * a single mistake by a legitimate user re-locks them immediately (OWASP
 * Authentication Cheat Sheet — counter resets once the lockout duration passes).
 */

import * as bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it } from 'bun:test';
import { ObjectId } from 'mongodb';
import { IdentityService } from '../../../packages/backend/src/auth/identity-service';

const EMAIL = 'user@test.local';
const PASSWORD = 'correct-horse';
const WRONG = 'nope';
const MAX = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Minimal stateful fake of the `user_identities` collection. Holds a single
 * password identity and applies `$set` (including dot-paths) on `updateOne`,
 * so the lockout counter carries across `verifyPassword` calls like real Mongo.
 */
function makeDb(seed: { passwordHash: string; failedAttempts?: number; lockedUntil?: Date | null; status?: string }) {
  const record: any = {
    _id: new ObjectId(),
    userId: 'user_1',
    type: 'password',
    providerUserId: EMAIL,
    email: EMAIL,
    status: seed.status ?? 'active',
    data: {
      passwordHash: seed.passwordHash,
      failedAttempts: seed.failedAttempts ?? 0,
      lockedUntil: seed.lockedUntil ?? undefined,
    },
  };

  const collection = {
    findOne: async (q: any) => (q.providerUserId === EMAIL || q.type === 'password' ? record : null),
    updateOne: async (_filter: any, update: any) => {
      for (const [path, value] of Object.entries(update.$set ?? {})) {
        if (path.startsWith('data.')) record.data[path.slice(5)] = value;
        else record[path] = value;
      }
      return { modifiedCount: 1 };
    },
    createIndex: async () => undefined,
  };

  const db = { collection: () => collection } as any;
  return { db, record };
}

describe('verifyPassword — lockout state machine', () => {
  let hash: string;
  beforeEach(() => {
    hash = bcrypt.hashSync(PASSWORD, 4);
  });

  it('returns identity_not_found for an unknown email', async () => {
    const db = { collection: () => ({ findOne: async () => null }) } as any;
    const res = await new IdentityService(db).verifyPassword('ghost@test.local', PASSWORD);
    expect(res).toEqual({ success: false, error: 'identity_not_found' });
  });

  it('returns identity_revoked for a revoked identity', async () => {
    const { db } = makeDb({ passwordHash: hash, status: 'revoked' });
    const res = await new IdentityService(db).verifyPassword(EMAIL, PASSWORD);
    expect(res.success).toBe(false);
    expect(res.error).toBe('identity_revoked');
  });

  it('succeeds with the right password and resets the counter + clears lockout', async () => {
    const { db, record } = makeDb({ passwordHash: hash, failedAttempts: 3 });
    const svc = new IdentityService(db);
    const res = await svc.verifyPassword(EMAIL, PASSWORD);
    expect(res.success).toBe(true);
    expect(res.identity).toBeDefined();
    expect(record.data.failedAttempts).toBe(0);
    expect(record.data.lockedUntil).toBeNull();
  });

  it('increments the counter on a wrong password without locking before MAX', async () => {
    const { db, record } = makeDb({ passwordHash: hash });
    const svc = new IdentityService(db);
    for (let i = 1; i < MAX; i++) {
      const res = await svc.verifyPassword(EMAIL, WRONG);
      expect(res.error).toBe('invalid_credentials');
      expect(res.lockedUntil).toBeUndefined();
      expect(record.data.failedAttempts).toBe(i);
    }
    expect(record.data.lockedUntil).toBeNull();
  });

  it('locks the account on the MAX-th consecutive failure', async () => {
    const { db, record } = makeDb({ passwordHash: hash, failedAttempts: MAX - 1 });
    const svc = new IdentityService(db);
    const before = Date.now();
    const res = await svc.verifyPassword(EMAIL, WRONG);
    expect(res.error).toBe('invalid_credentials');
    expect(res.lockedUntil).toBeInstanceOf(Date);
    expect(record.data.failedAttempts).toBe(MAX);
    // Lockout window ~15 min in the future.
    const delta = (record.data.lockedUntil as Date).getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(LOCKOUT_MS - 1000);
    expect(delta).toBeLessThanOrEqual(LOCKOUT_MS + 1000);
  });

  it('rejects with account_locked while the lockout is active (even with the right password)', async () => {
    const { db } = makeDb({ passwordHash: hash, failedAttempts: MAX, lockedUntil: new Date(Date.now() + LOCKOUT_MS) });
    const res = await new IdentityService(db).verifyPassword(EMAIL, PASSWORD);
    expect(res.success).toBe(false);
    expect(res.error).toBe('account_locked');
    expect(res.lockedUntil).toBeInstanceOf(Date);
  });

  it('after the lockout elapses, the right password succeeds and clears state', async () => {
    const { db, record } = makeDb({ passwordHash: hash, failedAttempts: MAX, lockedUntil: new Date(Date.now() - 1000) });
    const res = await new IdentityService(db).verifyPassword(EMAIL, PASSWORD);
    expect(res.success).toBe(true);
    expect(record.data.failedAttempts).toBe(0);
    expect(record.data.lockedUntil).toBeNull();
  });

  it('REGRESSION: after the lockout elapses, one wrong password does NOT re-lock (counter reset to 1)', async () => {
    // failedAttempts is still at MAX and lockedUntil is in the past. The fresh
    // attempt window must restart at 1, not continue at MAX+1 → no re-lock.
    const { db, record } = makeDb({ passwordHash: hash, failedAttempts: MAX, lockedUntil: new Date(Date.now() - 1000) });
    const res = await new IdentityService(db).verifyPassword(EMAIL, WRONG);
    expect(res.error).toBe('invalid_credentials');
    expect(res.lockedUntil).toBeUndefined();
    expect(record.data.failedAttempts).toBe(1);
    expect(record.data.lockedUntil).toBeNull(); // stale past lockout cleared
  });

  it('full sequence: 5 failures lock, lock blocks, success after expiry resets', async () => {
    const { db, record } = makeDb({ passwordHash: hash });
    const svc = new IdentityService(db);
    for (let i = 0; i < MAX; i++) await svc.verifyPassword(EMAIL, WRONG);
    expect(record.data.failedAttempts).toBe(MAX);
    expect(record.data.lockedUntil).toBeInstanceOf(Date);

    // Locked → even correct password is rejected.
    expect((await svc.verifyPassword(EMAIL, PASSWORD)).error).toBe('account_locked');

    // Simulate the window elapsing, then a correct login.
    record.data.lockedUntil = new Date(Date.now() - 1000);
    const ok = await svc.verifyPassword(EMAIL, PASSWORD);
    expect(ok.success).toBe(true);
    expect(record.data.failedAttempts).toBe(0);
    expect(record.data.lockedUntil).toBeNull();
  });
});
