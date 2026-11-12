/**
 * Unit tests for DeletionLogService - permanent record of every deletion.
 *
 * Coverage:
 *   1. logDeletion with deleteFn: log entry written, delete called, count updated.
 *   2. logDeletion without deleteFn: log entry written with explicit count/docIds.
 *   3. Log write failure: delete is NOT performed (log-first safety).
 *   4. Delete failure: log entry remains (orphaned), error re-thrown.
 *   5. docIds truncation when exceeding MAX_DOC_IDS_STORED.
 *   6. Count correction when deleteResult.deletedCount differs from initial.
 *   7. Query by collection, actor, reason, time range.
 *   8. ensureIndexes creates the expected indexes.
 *
 * Uses an in-memory mock collection - no real MongoDB connection needed.
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import type { Db } from 'mongodb';
import { DeletionLogService } from './deletion-log-service';
import { MAX_DOC_IDS_STORED } from '../models/deletion-log';

// --- Mock helpers ---

interface MockDoc {
  deletionLogId: string;
  collection: string;
  docIds: string[];
  filterSummary?: string;
  count: number;
  reason: string;
  actor: string;
  trigger: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * In-memory store that mimics the MongoDB collection interface used by
 * DeletionLogService: insertOne, updateOne, find, sort, limit, toArray, createIndex.
 */
function createMockCollection() {
  const store: MockDoc[] = [];
  let idCounter = 0;

  const insertOne = mock((doc: MockDoc) => {
    store.push({ ...doc, _id: 'mock_' + idCounter++ });
    return Promise.resolve({ acknowledged: true, insertedId: 'mock_' + (idCounter - 1) });
  });

  const updateOne = mock(
    (filter: Record<string, any>, update: Record<string, any>) => {
      const doc = store.find((d) =>
        Object.entries(filter).every(([k, v]) => d[k] === v),
      );
      if (doc && update.$set) {
        Object.assign(doc, update.$set);
        return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
      }
      return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
    },
  );

  const find = mock((query: Record<string, any>) => {
    let results = store.filter((doc) =>
      Object.entries(query).every(([k, v]) => {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          return Object.entries(v).every(([op, val]) => {
            if (op === '$gte') return doc[k] >= val;
            if (op === '$lte') return doc[k] <= val;
            return doc[k] === val;
          });
        }
        return doc[k] === v;
      }),
    );

    return {
      sort: mock((sortSpec: Record<string, number>) => {
        const entries = Object.entries(sortSpec);
        if (entries.length > 0) {
          const [field, direction] = entries[0];
          results = [...results].sort((a, b) => {
            if (direction === -1) return (b[field] as number) - (a[field] as number);
            return (a[field] as number) - (b[field] as number);
          });
        }
        return {
          limit: mock((n: number) => {
            results = results.slice(0, n);
            return {
              toArray: mock(() => Promise.resolve(results)),
            };
          }),
        };
      }),
    };
  });

  const createIndex = mock(() => Promise.resolve('idx_mock'));

  const collection = mock(() => ({
    insertOne,
    updateOne,
    find,
    createIndex,
  }));

  return { collection, store, insertOne, updateOne, find, createIndex };
}

function createMockDb(): { db: Db; mock: ReturnType<typeof createMockCollection> } {
  const mockCol = createMockCollection();
  const db = { collection: mockCol.collection } as unknown as Db;
  return { db, mock: mockCol };
}

// --- Constants ---

const COLLECTION = 'channels';
const ACTOR_USER = 'user_abc123';
const ACTOR_SYSTEM = 'system:ttl-sweeper';

// --- Tests ---

describe('DeletionLogService', () => {
  let service: DeletionLogService;
  let mockObj: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    const { db, mock: m } = createMockDb();
    mockObj = m;
    service = new DeletionLogService(db);
  });

  describe('logDeletion with deleteFn', () => {
    test('writes log entry then calls deleteFn, returns both', async () => {
      const deleteFn = mock(async () => ({
        acknowledged: true,
        deletedCount: 1,
      }));

      const result = await service.logDeletion({
        collection: COLLECTION,
        docIds: ['ch_001'],
        reason: 'channel_close',
        actor: ACTOR_USER,
        trigger: 'channel.close',
        deleteFn: deleteFn as any,
      });

      expect(mockObj.insertOne).toHaveBeenCalledTimes(1);
      const entry = mockObj.store[0];
      expect(entry.deletionLogId).toMatch(/^dl_/);
      expect(entry.collection).toBe(COLLECTION);
      expect(entry.docIds).toEqual(['ch_001']);
      expect(entry.reason).toBe('channel_close');
      expect(entry.actor).toBe(ACTOR_USER);
      expect(entry.trigger).toBe('channel.close');
      expect(entry.count).toBe(1);
      expect(typeof entry.timestamp).toBe('number');

      expect(deleteFn).toHaveBeenCalledTimes(1);

      expect(result.entry.deletionLogId).toBe(entry.deletionLogId);
      expect(result.deleteResult?.deletedCount).toBe(1);
    });

    test('updates count when deleteResult.deletedCount differs from initial', async () => {
      const deleteFn = mock(async () => ({
        acknowledged: true,
        deletedCount: 5,
      }));

      const result = await service.logDeletion({
        collection: 'mca_event_subscriptions',
        filterSummary: 'expireAt <= now',
        reason: 'subscription_cleanup',
        actor: ACTOR_SYSTEM,
        trigger: 'subscription.expiry',
        deleteFn: deleteFn as any,
      });

      expect(result.entry.count).toBe(5);
      expect(mockObj.updateOne).toHaveBeenCalledTimes(1);
      const [filter, update] = mockObj.updateOne.mock.calls[0];
      expect(filter.deletionLogId).toBe(result.entry.deletionLogId);
      expect(update.$set.count).toBe(5);
    });

    test('does not update count when deleteResult matches initial', async () => {
      const deleteFn = mock(async () => ({
        acknowledged: true,
        deletedCount: 3,
      }));

      await service.logDeletion({
        collection: COLLECTION,
        docIds: ['ch_1', 'ch_2', 'ch_3'],
        count: 3,
        reason: 'channel_close',
        actor: ACTOR_USER,
        trigger: 'channel.close',
        deleteFn: deleteFn as any,
      });

      expect(mockObj.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('logDeletion without deleteFn (log-only)', () => {
    test('writes log entry with explicit count and docIds', async () => {
      const result = await service.logDeletion({
        collection: 'apps',
        docIds: ['app_1', 'app_2', 'app_3'],
        count: 3,
        reason: 'app_uninstall',
        actor: ACTOR_USER,
        trigger: 'app.uninstall',
        metadata: { workspaceId: 'work_abc' },
      });

      expect(mockObj.insertOne).toHaveBeenCalledTimes(1);
      expect(result.entry.count).toBe(3);
      expect(result.entry.docIds).toEqual(['app_1', 'app_2', 'app_3']);
      expect(result.entry.metadata).toEqual({ workspaceId: 'work_abc' });
      expect(result.deleteResult).toBeUndefined();
    });

    test('defaults count to docIds.length when count omitted', async () => {
      const result = await service.logDeletion({
        collection: 'agents',
        docIds: ['agent_1'],
        reason: 'agent_delete',
        actor: ACTOR_USER,
        trigger: 'agent.delete',
      });

      expect(result.entry.count).toBe(1);
    });

    test('defaults count to 0 when no docIds and no count', async () => {
      const result = await service.logDeletion({
        collection: 'agents',
        filterSummary: 'status=archived',
        reason: 'soft_delete',
        actor: ACTOR_SYSTEM,
        trigger: 'agent.cleanup',
      });

      expect(result.entry.count).toBe(0);
      expect(result.entry.docIds).toEqual([]);
      expect(result.entry.filterSummary).toBe('status=archived');
    });
  });

  describe('log-first safety', () => {
    test('if log write fails, delete is NOT performed', async () => {
      const deleteFn = mock(async () => ({
        acknowledged: true,
        deletedCount: 1,
      }));

      mockObj.insertOne.mockImplementation(() =>
        Promise.reject(new Error('DB connection lost')),
      );

      await expect(
        service.logDeletion({
          collection: COLLECTION,
          docIds: ['ch_001'],
          reason: 'channel_close',
          actor: ACTOR_USER,
          trigger: 'channel.close',
          deleteFn: deleteFn as any,
        }),
      ).rejects.toThrow('DB connection lost');

      expect(deleteFn).not.toHaveBeenCalled();
    });

    test('if delete fails, log entry remains and error is re-thrown', async () => {
      const deleteFn = mock(async () => {
        throw new Error('Delete permission denied');
      });

      await expect(
        service.logDeletion({
          collection: COLLECTION,
          docIds: ['ch_001'],
          reason: 'channel_close',
          actor: ACTOR_USER,
          trigger: 'channel.close',
          deleteFn: deleteFn as any,
        }),
      ).rejects.toThrow('Delete permission denied');

      expect(mockObj.insertOne).toHaveBeenCalledTimes(1);
      expect(mockObj.store).toHaveLength(1);
      expect(mockObj.store[0].deletionLogId).toMatch(/^dl_/);
    });
  });

  describe('docIds truncation', () => {
    test('truncates docIds to MAX_DOC_IDS_STORED, keeps true count', async () => {
      const manyIds = Array.from({ length: MAX_DOC_IDS_STORED + 500 }, (_, i) => 'doc_' + i);
      const trueCount = manyIds.length;

      const result = await service.logDeletion({
        collection: 'messages',
        docIds: manyIds,
        count: trueCount,
        reason: 'expiry_cleanup',
        actor: ACTOR_SYSTEM,
        trigger: 'message.expiry',
      });

      expect(result.entry.docIds.length).toBe(MAX_DOC_IDS_STORED);
      expect(result.entry.count).toBe(trueCount);
    });

    test('does not truncate when docIds <= MAX_DOC_IDS_STORED', async () => {
      const ids = Array.from({ length: 100 }, (_, i) => 'doc_' + i);

      const result = await service.logDeletion({
        collection: 'messages',
        docIds: ids,
        reason: 'expiry_cleanup',
        actor: ACTOR_SYSTEM,
        trigger: 'message.expiry',
      });

      expect(result.entry.docIds.length).toBe(100);
      expect(result.entry.count).toBe(100);
    });
  });

  describe('query', () => {
    test('returns entries filtered by collection, sorted newest first', async () => {
      await service.logDeletion({
        collection: 'channels', docIds: ['ch_1'], reason: 'channel_close',
        actor: ACTOR_USER, trigger: 'channel.close',
      });
      await service.logDeletion({
        collection: 'apps', docIds: ['app_1'], reason: 'app_uninstall',
        actor: ACTOR_USER, trigger: 'app.uninstall',
      });
      await service.logDeletion({
        collection: 'channels', docIds: ['ch_2'], reason: 'channel_close',
        actor: ACTOR_USER, trigger: 'channel.close',
      });

      const results = await service.query({ collection: 'channels' });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.collection === 'channels')).toBe(true);
      expect(results[0].timestamp).toBeGreaterThanOrEqual(results[1].timestamp);
    });

    test('filters by actor', async () => {
      await service.logDeletion({
        collection: 'channels', docIds: ['ch_1'], reason: 'channel_close',
        actor: ACTOR_USER, trigger: 'channel.close',
      });
      await service.logDeletion({
        collection: 'apps', docIds: ['app_1'], reason: 'app_uninstall',
        actor: ACTOR_SYSTEM, trigger: 'subscription.expiry',
      });

      const results = await service.query({ actor: ACTOR_SYSTEM });
      expect(results).toHaveLength(1);
      expect(results[0].actor).toBe(ACTOR_SYSTEM);
    });

    test('filters by reason', async () => {
      await service.logDeletion({
        collection: 'channels', docIds: ['ch_1'], reason: 'channel_close',
        actor: ACTOR_USER, trigger: 'channel.close',
      });
      await service.logDeletion({
        collection: 'agents', docIds: ['ag_1'], reason: 'agent_delete',
        actor: ACTOR_USER, trigger: 'agent.delete',
      });

      const results = await service.query({ reason: 'agent_delete' });
      expect(results).toHaveLength(1);
      expect(results[0].reason).toBe('agent_delete');
    });

    test('applies limit', async () => {
      for (let i = 0; i < 5; i++) {
        await service.logDeletion({
          collection: 'channels', docIds: ['ch_' + i], reason: 'channel_close',
          actor: ACTOR_USER, trigger: 'channel.close',
        });
      }

      const results = await service.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });
  });

  describe('ensureIndexes', () => {
    test('creates the expected indexes', async () => {
      await service.ensureIndexes();
      expect(mockObj.createIndex.mock.calls.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('deletionLogId format', () => {
    test('generates unique ids with dl_ prefix', async () => {
      const result1 = await service.logDeletion({
        collection: 'test', docIds: ['d1'], reason: 'other',
        actor: ACTOR_USER, trigger: 'test',
      });
      const result2 = await service.logDeletion({
        collection: 'test', docIds: ['d2'], reason: 'other',
        actor: ACTOR_USER, trigger: 'test',
      });

      expect(result1.entry.deletionLogId).toMatch(/^dl_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(result2.entry.deletionLogId).toMatch(/^dl_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(result1.entry.deletionLogId).not.toBe(result2.entry.deletionLogId);
    });
  });
});
