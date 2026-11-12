/**
 * Unified subscriptions (v1.4.4) — unit tests.
 *
 * Covers the pure pieces of the shared `subscriptions` capability and the
 * unified filter evaluator: local→full topic resolution, filter validation
 * against the declaration (the INVALID_FILTER acceptance criterion), the
 * evaluator semantics (AND/OR, operators), and the shared-capability
 * dispatch. The MongoDB-backed actions are exercised through an in-memory
 * stand-in for the collection API surface they use.
 */
import { describe, expect, it } from 'bun:test';
import {
  type DeclaredEventFilters,
  type UnifiedFilter,
  unifiedFilterMatches,
} from '../models/mca-event-subscriptions';
import { handleMcaAction } from './index';

// ─── unifiedFilterMatches (the evaluator used at dispatch time) ────────────

const gmailFilters: DeclaredEventFilters = {
  from: { type: 'string', operator: 'contains' },
  subject: { type: 'string', operator: 'contains' },
  accountEmail: { type: 'string', operator: 'equals' },
};

describe('unifiedFilterMatches', () => {
  const payload = {
    from: 'Alice <alice@example.com>',
    subject: 'Quarterly report',
    accountEmail: 'me@teros.ai',
  };

  it('empty filter always matches', () => {
    expect(unifiedFilterMatches({}, gmailFilters, payload)).toBe(true);
    expect(unifiedFilterMatches(undefined, gmailFilters, payload)).toBe(true);
  });

  it('contains operator is case-insensitive substring', () => {
    expect(unifiedFilterMatches({ from: 'alice@example.com' }, gmailFilters, payload)).toBe(true);
    expect(unifiedFilterMatches({ from: 'ALICE' }, gmailFilters, payload)).toBe(true);
    expect(unifiedFilterMatches({ from: 'bob@example.com' }, gmailFilters, payload)).toBe(false);
  });

  it('equals operator is strict', () => {
    expect(unifiedFilterMatches({ accountEmail: 'me@teros.ai' }, gmailFilters, payload)).toBe(true);
    expect(unifiedFilterMatches({ accountEmail: 'me@teros' }, gmailFilters, payload)).toBe(false);
  });

  it('fields are AND-ed', () => {
    expect(unifiedFilterMatches({ from: 'alice', subject: 'report' }, gmailFilters, payload)).toBe(true);
    expect(unifiedFilterMatches({ from: 'alice', subject: 'invoice' }, gmailFilters, payload)).toBe(false);
  });

  it('values within a field are OR-ed (array)', () => {
    expect(unifiedFilterMatches({ from: ['bob', 'alice'] }, gmailFilters, payload)).toBe(true);
    expect(unifiedFilterMatches({ from: ['bob', 'carol'] }, gmailFilters, payload)).toBe(false);
  });

  it('mapsTo redirects the tested payload field', () => {
    const spec: DeclaredEventFilters = { sender: { type: 'string', operator: 'equals', mapsTo: 'from' } };
    // filter field 'sender' tests payload field 'from'
    expect(unifiedFilterMatches({ sender: 'alice@example.com' }, spec, { from: 'alice@example.com' })).toBe(true);
    // without mapsTo the same value would test 'sender' (absent) — no match
    const noMap: DeclaredEventFilters = { sender: { type: 'string', operator: 'equals' } };
    expect(unifiedFilterMatches({ sender: 'alice@example.com' }, noMap, { from: 'alice@example.com' })).toBe(false);
  });

  it('anyOf against an array payload is membership', () => {
    const spec: DeclaredEventFilters = { groupNodeIds: { type: 'string', operator: 'anyOf' } };
    const payloadGroups = { groupNodeIds: ['g1', 'g2'] };
    expect(unifiedFilterMatches({ groupNodeIds: 'g1' }, spec, payloadGroups)).toBe(true);
    expect(unifiedFilterMatches({ groupNodeIds: 'g9' }, spec, payloadGroups)).toBe(false);
  });

  it('a filter on an event declared without filters never matches', () => {
    expect(unifiedFilterMatches({ from: 'alice' }, undefined, payload)).toBe(false);
  });
});

// ─── handleMcaAction: shared capability + declaration allowlist ────────────

/** Minimal Db stand-in: only what the subscriptions capability touches. */
function fakeDb(catalogEvents: Array<Record<string, unknown>>, subs: Array<Record<string, unknown>> = []) {
  const catalogCol = {
    findOne: async (q: Record<string, unknown>) =>
      q.mcaId === 'mca.google.gmail' ? { events: catalogEvents } : null,
  };
  const subsCol = {
    find: (_q: Record<string, unknown>) => ({ toArray: async () => subs.filter((s) => s) }),
    deleteOne: async (q: Record<string, unknown>) => {
      const i = subs.findIndex((s) => s.id === q.id);
      if (i >= 0) { subs.splice(i, 1); return { deletedCount: 1 }; }
      return { deletedCount: 0 };
    },
    deleteMany: async (q: Record<string, unknown>) => {
      const before = subs.length;
      for (let i = subs.length - 1; i >= 0; i--) {
        const s = subs[i] as Record<string, unknown>;
        const topicOk = !q.topic || (typeof q.topic === 'string' ? s.topic === q.topic : (q.topic as any).$in.includes(s.topic));
        const chOk = !q.channelId || s.channelId === q.channelId;
        if (topicOk && chOk) subs.splice(i, 1);
      }
      return { deletedCount: before - subs.length };
    },
    countDocuments: async (q: Record<string, unknown>) =>
      subs.filter((s) => (!q.topic || s.topic === q.topic)).length,
    insertOne: async (doc: Record<string, unknown>) => { subs.push(doc); return { acknowledged: true }; },
  };
  return {
    collection: (name: string) => (name === 'mca_catalog' ? catalogCol : subsCol),
  } as any;
}

const gmailDeclared = [
  {
    topic: 'gmail.email.received',
    description: 'A new email arrived.',
    payload: { from: 'string', subject: 'string' },
    filters: {
      from: { type: 'string', operator: 'contains' },
      subject: { type: 'string', operator: 'contains' },
      accountEmail: { type: 'string', operator: 'equals' },
    },
  },
];

const ctx = { mcaId: 'mca.google.gmail', appId: 'app_1', userId: 'user_1', channelId: 'ch_1' };

describe('subscriptions capability (shared, declaration-validated)', () => {
  it('accepts the LOCAL event name and resolves it to the full bus topic', async () => {
    const db = fakeDb(gmailDeclared, []);
    const res = await handleMcaAction(ctx, db, 'subscriptions/subscribe', { event: 'email.received' });
    expect(res.status).toBe(200);
    const sub = (res.body as any).subscription;
    expect(sub.topic).toBe('gmail.email.received');
    expect(sub.event).toBe('email.received');
    expect(sub.channelId).toBe('ch_1');
  });

  it('rejects an undeclared event with UNDECLARED_EVENT and the declared list', async () => {
    const db = fakeDb(gmailDeclared, []);
    const res = await handleMcaAction(ctx, db, 'subscriptions/subscribe', { event: 'email.sent' });
    expect(res.status).toBe(404);
    expect((res.body as any).code).toBe('UNDECLARED_EVENT');
    expect((res.body as any).error).toContain('gmail.email.received');
  });

  it('rejects an invalid filter field with INVALID_FILTER naming the valid fields (acceptance criterion)', async () => {
    const db = fakeDb(gmailDeclared, []);
    const res = await handleMcaAction(ctx, db, 'subscriptions/subscribe', {
      event: 'email.received',
      filter: { importance: 'high' },
    });
    expect(res.status).toBe(400);
    const body = res.body as any;
    expect(body.code).toBe('INVALID_FILTER');
    expect(body.error).toContain('importance');
    expect(body.error).toContain('from');
    expect(body.suggestion).toContain('subject');
  });

  it('rejects a wrongly-typed filter value', async () => {
    const db = fakeDb(gmailDeclared, []);
    const res = await handleMcaAction(ctx, db, 'subscriptions/subscribe', {
      event: 'email.received',
      filter: { from: 42 },
    });
    expect(res.status).toBe(400);
    expect((res.body as any).code).toBe('INVALID_FILTER');
  });

  it('accepts a valid filter and snapshots the declaration into the subscription', async () => {
    const db = fakeDb(gmailDeclared, []);
    const res = await handleMcaAction(ctx, db, 'subscriptions/subscribe', {
      event: 'email.received',
      filter: { from: 'alice@example.com' },
    });
    expect(res.status).toBe(200);
    const sub = (res.body as any).subscription;
    expect(sub.filter).toEqual({ from: 'alice@example.com' });
  });

  it('rejects a filter when the event declares no filter fields', async () => {
    const declaredNoFilters = [{ topic: 'gmail.email.received', description: 'x', payload: {} }];
    const db = fakeDb(declaredNoFilters, []);
    const res = await handleMcaAction(ctx, db, 'subscriptions/subscribe', {
      event: 'email.received',
      filter: { from: 'alice' },
    });
    expect(res.status).toBe(400);
    expect((res.body as any).code).toBe('INVALID_FILTER');
  });

  it('an MCA with no declared events cannot subscribe (fail closed)', async () => {
    const db = fakeDb([], []);
    const res = await handleMcaAction(ctx, db, 'subscriptions/subscribe', { event: 'email.received' });
    expect(res.status).toBe(404);
    expect((res.body as any).code).toBe('UNDECLARED_EVENT');
  });

  it('another mcaId still cannot invoke a bound capability (regression guard)', async () => {
    const db = fakeDb(gmailDeclared, []);
    // todo is bound to mca.teros.todo-list; the gmail identity must get 403
    // (binding check fires before any handler runs).
    const gmailCtx = { mcaId: 'mca.google.gmail', appId: 'app_1', userId: 'u1' };
    const res = await handleMcaAction(gmailCtx, db, 'todo/get-tree', {});
    expect(res.status).toBe(403);
  });

  it('list returns only this app\'s subscriptions plus the event catalog', async () => {
    const subs = [
      { id: 's1', topic: 'gmail.email.received', channelId: 'ch_1', mode: 'wake', filter: { from: 'alice' }, createdAt: new Date() },
      { id: 's2', topic: 'todo.task_completed', channelId: 'ch_1', mode: 'wake', filter: {}, createdAt: new Date() },
    ];
    const db = fakeDb(gmailDeclared, subs);
    const res = await handleMcaAction(ctx, db, 'subscriptions/list', {});
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].subscriptionId).toBe('s1');
    expect(body.events[0].event).toBe('email.received');
    expect(body.events[0].filters.from.operator).toBe('contains');
  });

  it('unsubscribe by event name removes the channel\'s subscription to that topic', async () => {
    const subs = [
      { id: 's1', topic: 'gmail.email.received', channelId: 'ch_1', mode: 'wake' },
      { id: 's2', topic: 'gmail.email.received', channelId: 'ch_2', mode: 'wake' },
    ];
    const db = fakeDb(gmailDeclared, subs);
    const res = await handleMcaAction(ctx, db, 'subscriptions/unsubscribe', { event: 'email.received' });
    expect(res.status).toBe(200);
    expect((res.body as any).deleted).toBe(1);
    expect(subs.map((s) => s.id)).toEqual(['s2']);
  });

  it('has-subscribers counts across every channel (gmail watcher lifecycle)', async () => {
    const subs = [{ id: 's1', topic: 'gmail.email.received', channelId: 'ch_9', mode: 'wake' }];
    const db = fakeDb(gmailDeclared, subs);
    const res = await handleMcaAction(ctx, db, 'subscriptions/has-subscribers', { topic: 'email.received' });
    expect(res.status).toBe(200);
    expect((res.body as any).hasSubscribers).toBe(true);
    expect((res.body as any).subscriberCount).toBe(1);
  });

  it('wakeUpOn local names are resolved to full topics', async () => {
    const declared = [
      { topic: 'gmail.email.received', description: 'x' },
      { topic: 'gmail.thread.updated', description: 'y' },
    ];
    const db = fakeDb(declared, []);
    const res = await handleMcaAction(ctx, db, 'subscriptions/subscribe', {
      event: 'email.received',
      wakeUpOn: ['email.received'],
    });
    expect(res.status).toBe(200);
    expect((res.body as any).subscription.wakeUpOn).toEqual(['gmail.email.received']);
  });
});
