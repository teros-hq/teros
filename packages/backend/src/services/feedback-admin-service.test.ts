/**
 * FeedbackAdminService — standardized resolution model unit tests.
 *
 * Covers the task tn_e86UrjJtC4y9JCOb behaviors:
 *   - view → status query mapping (tracking / future / dismissed / completed)
 *   - dismissing REQUIRES a dismissReason; reason is cleared on other transitions
 *   - resolving emails the reporter (and records reporterNotifiedAt)
 *   - email failures are non-fatal (recorded in reporterNotifyError)
 *   - create() registers out-of-band intake with a source
 *
 * The Db/collection is a hand-rolled fake (same pattern as automate-runner.test.ts)
 * — no Mongo dependency. getEmailService is mocked via module mock.
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import type { Db } from 'mongodb';

// Mock the email service module BEFORE importing the service under test.
const sendFeedbackResolvedMock = mock(async () => ({ success: true }));
mock.module('../services/email-service', () => ({
  getEmailService: () => ({ sendFeedbackResolved: sendFeedbackResolvedMock }),
}));

import {
  FeedbackAdminService,
  FeedbackValidationError,
  viewToStatusQuery,
} from './feedback-admin-service';
import type { FeedbackDoc } from './feedback-admin-service';

// ── fake collection ─────────────────────────────────────────────────────────

interface FakeCollection {
  docs: Map<string, FeedbackDoc>;
  find(query: Record<string, unknown>): { sort(): { limit(): { toArray(): Promise<FeedbackDoc[]> } } };
  findOne(query: Record<string, unknown>): Promise<FeedbackDoc | null>;
  insertOne(doc: FeedbackDoc): Promise<void>;
  updateOne(query: Record<string, unknown>, update: Record<string, unknown>): Promise<{ matchedCount: number }>;
}

function matches(doc: FeedbackDoc, query: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(query)) {
    if (v && typeof v === 'object' && '$in' in (v as object)) {
      if (!(v as { $in: unknown[] }).$in.includes((doc as unknown as Record<string, unknown>)[k])) return false;
    } else if ((doc as unknown as Record<string, unknown>)[k] !== v) {
      return false;
    }
  }
  return true;
}

function makeFakeDb(docs: FeedbackDoc[] = [], users: Array<{ userId: string; profile?: { email?: string } }> = []) {
  const store = new Map<string, FeedbackDoc>(docs.map((d) => [d.feedbackId, { ...d }]));
  const userStore = new Map(users.map((u) => [u.userId, u]));
  const collection: FakeCollection = {
    docs: store,
    find(query) {
      const results = [...store.values()].filter((d) => matches(d, query));
      return {
        sort: () => ({
          limit: () => ({
            toArray: async () => results,
          }),
        }),
      };
    },
    async findOne(query) {
      const id = query.feedbackId as string;
      return store.get(id) ? { ...store.get(id)! } : null;
    },
    async insertOne(doc) {
      store.set(doc.feedbackId, { ...doc });
    },
    async updateOne(query, update) {
      const id = query.feedbackId as string;
      const doc = store.get(id);
      if (!doc) return { matchedCount: 0 };
      const $set = (update.$set ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries($set)) {
        (doc as unknown as Record<string, unknown>)[k] = v;
      }
      const $push = (update.$push ?? {}) as Record<string, unknown[]>;
      for (const [k, v] of Object.entries($push)) {
        const arr = (doc as unknown as Record<string, unknown[]>)[k] ?? [];
        arr.push(...(Array.isArray(v) ? v : [v]));
        (doc as unknown as Record<string, unknown>)[k] = arr;
      }
      return { matchedCount: 1 };
    },
  };
  // Dispatch by collection name: 'feedback' → the fake above, 'users' → the
  // userStore (only findOne with a projection is used by the service).
  const db = {
    collection: (name: string) => {
      if (name === 'users') {
        return {
          findOne: async (query: { userId: string }) => userStore.get(query.userId) ?? null,
        };
      }
      return collection;
    },
  } as unknown as Db;
  return { db, collection };
}

// ── fixtures ────────────────────────────────────────────────────────────────

function makeDoc(overrides: Partial<FeedbackDoc> = {}): FeedbackDoc {
  return {
    feedbackId: 'fb_test1',
    type: 'bug',
    title: 'Test bug',
    description: 'desc',
    reportedBy: 'user_1',
    status: 'open',
    updates: [],
    hasUnreadUpdates: false,
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  sendFeedbackResolvedMock.mockClear();
});

// ── viewToStatusQuery ───────────────────────────────────────────────────────

describe('viewToStatusQuery', () => {
  it('maps tracking to the three active statuses', () => {
    expect(viewToStatusQuery('tracking')).toEqual({ status: { $in: ['open', 'in_review', 'in_progress'] } });
  });

  it('maps future to postponed', () => {
    expect(viewToStatusQuery('future')).toEqual({ status: 'postponed' });
  });

  it('maps dismissed and completed to their statuses', () => {
    expect(viewToStatusQuery('dismissed')).toEqual({ status: 'dismissed' });
    expect(viewToStatusQuery('completed')).toEqual({ status: 'resolved' });
  });

  it('all returns no filter', () => {
    expect(viewToStatusQuery('all')).toBeNull();
  });
});

// ── list ────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('filters by the tracking view', async () => {
    const { db } = makeFakeDb([
      makeDoc({ feedbackId: 'a', status: 'open' }),
      makeDoc({ feedbackId: 'b', status: 'postponed' }),
      makeDoc({ feedbackId: 'c', status: 'resolved' }),
    ]);
    const service = new FeedbackAdminService(db);
    const result = await service.list({ view: 'tracking' });
    expect(result.feedbacks.map((f) => f.feedbackId)).toEqual(['a']);
    expect(result.stats.byStatus.open).toBe(1);
  });

  it('returns dismissReason and source on list rows', async () => {
    const { db } = makeFakeDb([
      makeDoc({ feedbackId: 'a', status: 'dismissed', dismissReason: 'invalid', source: 'conversation' }),
    ]);
    const service = new FeedbackAdminService(db);
    const result = await service.list({ view: 'dismissed' });
    expect(result.feedbacks[0].dismissReason).toBe('invalid');
    expect(result.feedbacks[0].source).toBe('conversation');
  });
});

// ── updateStatus ────────────────────────────────────────────────────────────

describe('updateStatus', () => {
  it('requires a dismissReason when dismissing', async () => {
    const { db } = makeFakeDb([makeDoc()]);
    const service = new FeedbackAdminService(db);
    expect(
      service.updateStatus({ feedbackId: 'fb_test1', status: 'dismissed', adminUserId: 'admin_1' }),
    ).rejects.toThrow(FeedbackValidationError);
  });

  it('rejects a dismissReason on non-dismissed transitions', async () => {
    const { db } = makeFakeDb([makeDoc()]);
    const service = new FeedbackAdminService(db);
    expect(
      service.updateStatus({
        feedbackId: 'fb_test1',
        status: 'in_progress',
        dismissReason: 'wont_fix',
        adminUserId: 'admin_1',
      }),
    ).rejects.toThrow(FeedbackValidationError);
  });

  it('dismiss stores the reason and sets resolvedAt', async () => {
    const { db, collection } = makeFakeDb([makeDoc()]);
    const service = new FeedbackAdminService(db);
    const result = await service.updateStatus({
      feedbackId: 'fb_test1',
      status: 'dismissed',
      dismissReason: 'wont_fix',
      adminUserId: 'admin_1',
    });
    expect(result.success).toBe(true);
    const doc = collection.docs.get('fb_test1')!;
    expect(doc.status).toBe('dismissed');
    expect(doc.dismissReason).toBe('wont_fix');
    expect(doc.resolvedAt).toBeDefined();
    expect(doc.updates).toHaveLength(1);
    expect(doc.updates[0].newStatus).toBe('dismissed');
  });

  it('postponing lands in the future view without resolvedAt', async () => {
    const { db, collection } = makeFakeDb([makeDoc()]);
    const service = new FeedbackAdminService(db);
    await service.updateStatus({ feedbackId: 'fb_test1', status: 'postponed', adminUserId: 'admin_1' });
    const doc = collection.docs.get('fb_test1')!;
    expect(doc.status).toBe('postponed');
    expect(doc.resolvedAt).toBeUndefined();
  });

  it('clears a stale dismissReason when moving out of dismissed', async () => {
    const { db, collection } = makeFakeDb([
      makeDoc({ status: 'dismissed', dismissReason: 'invalid', resolvedAt: '2026-10-28T00:00:00.000Z' }),
    ]);
    const service = new FeedbackAdminService(db);
    await service.updateStatus({ feedbackId: 'fb_test1', status: 'open', adminUserId: 'admin_1' });
    const doc = collection.docs.get('fb_test1')!;
    expect(doc.status).toBe('open');
    expect(doc.dismissReason).toBeUndefined();
  });

  it('resolving emails the reporter and records reporterNotifiedAt', async () => {
    const { db, collection } = makeFakeDb(
      [makeDoc()],
      [{ userId: 'user_1', profile: { email: 'reporter@example.com' } }],
    );
    const service = new FeedbackAdminService(db);
    const result = await service.updateStatus({
      feedbackId: 'fb_test1',
      status: 'resolved',
      message: 'Fixed in v1.4.3',
      adminUserId: 'admin_1',
    });
    expect(result.success).toBe(true);
    expect(result.reporterNotified).toBe(true);
    expect(sendFeedbackResolvedMock).toHaveBeenCalledTimes(1);
    const doc = collection.docs.get('fb_test1')!;
    expect(doc.reporterNotifiedAt).toBeDefined();
    expect(doc.reporterNotifyError).toBeUndefined();
  });

  it('notifyReporter=false skips the email', async () => {
    const { db } = makeFakeDb([makeDoc()]);
    const service = new FeedbackAdminService(db);
    const result = await service.updateStatus({
      feedbackId: 'fb_test1',
      status: 'resolved',
      notifyReporter: false,
      adminUserId: 'admin_1',
    });
    expect(result.reporterNotified).toBe(false);
    expect(sendFeedbackResolvedMock).not.toHaveBeenCalled();
  });

  it('email failure is non-fatal and recorded', async () => {
    sendFeedbackResolvedMock.mockImplementationOnce(async () => {
      throw new Error('SMTP down');
    });
    const { db, collection } = makeFakeDb(
      [makeDoc()],
      [{ userId: 'user_1', profile: { email: 'reporter@example.com' } }],
    );
    const service = new FeedbackAdminService(db);
    const result = await service.updateStatus({
      feedbackId: 'fb_test1',
      status: 'resolved',
      adminUserId: 'admin_1',
    });
    // The status change itself still succeeds.
    expect(result.success).toBe(true);
    expect(result.reporterNotified).toBe(false);
    const doc = collection.docs.get('fb_test1')!;
    expect(doc.status).toBe('resolved');
    expect(doc.reporterNotifyError).toBe('SMTP down');
  });

  it('returns error for an unknown feedbackId', async () => {
    const { db } = makeFakeDb([]);
    const service = new FeedbackAdminService(db);
    const result = await service.updateStatus({
      feedbackId: 'fb_nope',
      status: 'resolved',
      adminUserId: 'admin_1',
    });
    expect(result).toEqual({ success: false, error: 'Feedback not found' });
  });
});

// ── create (out-of-band intake) ─────────────────────────────────────────────

describe('create', () => {
  it('registers an out-of-band report with source and open status', async () => {
    const { db, collection } = makeFakeDb([]);
    const service = new FeedbackAdminService(db);
    const doc = await service.create({
      type: 'bug',
      title: 'HubSpot create-engagement 400',
      description: 'Reported by Álvaro in a conversation',
      reportedBy: 'user_alvaro',
      reportedByName: 'Álvaro',
      source: 'conversation',
    });
    expect(doc.status).toBe('open');
    expect(doc.source).toBe('conversation');
    const stored = collection.docs.get(doc.feedbackId)!;
    expect(stored.title).toBe('HubSpot create-engagement 400');
    expect(stored.reportedByName).toBe('Álvaro');
  });

  it('defaults source to manual', async () => {
    const { db } = makeFakeDb([]);
    const service = new FeedbackAdminService(db);
    const doc = await service.create({
      type: 'suggestion',
      title: 'x',
      description: 'y',
      reportedBy: 'user_1',
    });
    expect(doc.source).toBe('manual');
  });
});
