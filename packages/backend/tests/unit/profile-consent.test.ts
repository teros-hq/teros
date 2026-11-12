/**
 * Unit tests — profile.set-evaluation-consent (task_047a4844b9103db3).
 *
 * Covers:
 *   - validation: non-boolean evaluationOptIn → BAD_REQUEST.
 *   - self-service only: the flag is written on ctx.userId; a userId in the
 *     payload is ignored (there is no target-user parameter at all).
 *   - persistence: consent.evaluationOptIn / evaluationConsentAt /
 *     evaluationConsentVersion land on the user document.
 *   - versioning: the version is stamped server-side (EVALUATION_CONSENT_VERSION),
 *     not taken from the client.
 *   - audit: every change (on and off) writes a consent_audit_log entry with
 *     actor, action, timestamp and consentVersion.
 *   - unknown user → USER_NOT_FOUND.
 *
 * Db is fully mocked in-memory — no real MongoDB.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';

import {
  createSetEvaluationConsentHandler,
  EVALUATION_CONSENT_VERSION,
} from '../../src/handlers/domains/profile/consent';
import { UserService } from '../../src/auth/user-service';

// ---------------------------------------------------------------------------
// In-memory Mongo mock (same minimal surface as mca-actions-evaluator.test.ts)
// ---------------------------------------------------------------------------

type Doc = Record<string, any>;

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([k, v]) => {
    const dv = k.split('.').reduce((acc: any, part) => acc?.[part], doc);
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.entries(v).every(([op, ov]) => {
        if (op === '$exists') return ov ? dv !== undefined : dv === undefined;
        return dv === ov;
      });
    }
    return dv === v;
  });
}

function makeCol(initial: Doc[] = []) {
  const docs = initial.map((d) => ({ ...d }));
  const col = {
    docs,
    findOne: mock(async (filter: Doc) => docs.find((d) => matches(d, filter)) ?? null),
    findOneAndUpdate: mock(async (filter: Doc, update: Doc, _opts?: Doc) => {
      const idx = docs.findIndex((d) => matches(d, filter));
      if (idx < 0) return null;
      const $set = update.$set ?? {};
      // shallow-merge dot-paths into nested objects (consent.*)
      for (const [k, v] of Object.entries($set)) {
        if (k.includes('.')) {
          const [head, ...rest] = k.split('.');
          docs[idx][head] = docs[idx][head] ?? {};
          let cur = docs[idx][head];
          for (const part of rest.slice(0, -1)) {
            cur[part] = cur[part] ?? {};
            cur = cur[part];
          }
          cur[rest[rest.length - 1]] = v;
        } else {
          docs[idx][k] = v;
        }
      }
      return docs[idx];
    }),
    insertOne: mock(async (doc: Doc) => {
      docs.push({ ...doc });
      return { acknowledged: true, insertedId: 'x' };
    }),
    createIndex: mock(async () => 'ok'),
  };
  return col;
}

function makeDb(collections: Record<string, Doc[]>) {
  const cols = new Map<string, ReturnType<typeof makeCol>>();
  for (const [name, docs] of Object.entries(collections)) cols.set(name, makeCol(docs));
  return {
    collection: (name: string) => {
      if (!cols.has(name)) cols.set(name, makeCol());
      return cols.get(name)!;
    },
    _cols: cols,
  } as any;
}

const USER = 'user_plain';

function makeUserService(db: any) {
  return new UserService(db);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('profile.set-evaluation-consent', () => {
  const ctx = { userId: USER } as any;

  it('rejects a non-boolean evaluationOptIn', async () => {
    const db = makeDb({ users: [{ userId: USER, profile: { displayName: 'P', email: 'p@x' } }] });
    const handler = createSetEvaluationConsentHandler(makeUserService(db));
    await expect(handler(ctx, { evaluationOptIn: 'yes' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(handler(ctx, {})).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('persists the flag, timestamp and version on the user document', async () => {
    const db = makeDb({ users: [{ userId: USER, profile: { displayName: 'P', email: 'p@x' } }] });
    const handler = createSetEvaluationConsentHandler(makeUserService(db));
    const res = await handler(ctx, { evaluationOptIn: true });
    expect(res.evaluationOptIn).toBe(true);
    expect(res.evaluationConsentVersion).toBe(EVALUATION_CONSENT_VERSION);
    expect(res.evaluationConsentAt).toBeDefined();

    const user = db._cols.get('users').docs[0];
    expect(user.consent.evaluationOptIn).toBe(true);
    expect(user.consent.evaluationConsentVersion).toBe(EVALUATION_CONSENT_VERSION);
    expect(user.consent.evaluationConsentAt instanceof Date).toBe(true);
  });

  it('is self-service: the payload cannot target another user', async () => {
    const db = makeDb({
      users: [
        { userId: USER, profile: { displayName: 'P', email: 'p@x' } },
        { userId: 'user_victim', profile: { displayName: 'V', email: 'v@x' } },
      ],
    });
    const handler = createSetEvaluationConsentHandler(makeUserService(db));
    // A malicious payload tries to consent on behalf of someone else.
    await handler(ctx, { evaluationOptIn: true, userId: 'user_victim' } as any);
    const victim = db._cols.get('users').docs.find((d: Doc) => d.userId === 'user_victim');
    expect(victim.consent).toBeUndefined(); // untouched
    const self = db._cols.get('users').docs.find((d: Doc) => d.userId === USER);
    expect(self.consent.evaluationOptIn).toBe(true); // applied to the caller
  });

  it('stamps the consent version server-side (client cannot choose it)', async () => {
    const db = makeDb({ users: [{ userId: USER, profile: { displayName: 'P', email: 'p@x' } }] });
    const handler = createSetEvaluationConsentHandler(makeUserService(db));
    const res = await handler(ctx, { evaluationOptIn: true, consentVersion: 'v0-forged' } as any);
    expect(res.evaluationConsentVersion).toBe(EVALUATION_CONSENT_VERSION);
    expect(db._cols.get('users').docs[0].consent.evaluationConsentVersion).toBe(
      EVALUATION_CONSENT_VERSION,
    );
  });

  it('audits every change (on and off) in consent_audit_log', async () => {
    const db = makeDb({ users: [{ userId: USER, profile: { displayName: 'P', email: 'p@x' } }] });
    const handler = createSetEvaluationConsentHandler(makeUserService(db));
    await handler(ctx, { evaluationOptIn: true });
    await handler(ctx, { evaluationOptIn: false });

    const audit = db._cols.get('consent_audit_log').docs;
    expect(audit.length).toBe(2);
    expect(audit[0].action).toBe('on');
    expect(audit[1].action).toBe('off');
    for (const entry of audit) {
      expect(entry.userId).toBe(USER);
      expect(entry.actor).toBe(USER);
      expect(entry.key).toBe('evaluation_opt_in');
      expect(entry.consentVersion).toBe(EVALUATION_CONSENT_VERSION);
      expect(typeof entry.timestamp).toBe('string');
    }
  });

  it('throws USER_NOT_FOUND for an unknown caller', async () => {
    const db = makeDb({ users: [] });
    const handler = createSetEvaluationConsentHandler(makeUserService(db));
    await expect(handler(ctx, { evaluationOptIn: true })).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });
});
