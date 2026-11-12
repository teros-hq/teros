/**
 * Unit tests for ChannelManager.renameChannel — task-linked channel block.
 *
 * A channel linked to a board task (task.channelId) cannot be renamed:
 * the task owns the title (invariant: task title = linked conversation
 * title). Renames of unlinked channels keep working.
 *
 * Coverage:
 *   1. Unlinked channel → rename succeeds (metadata.name updated).
 *   2. Task-linked channel → rename REJECTED with a clear error that
 *      includes the task title.
 *   3. Task-linked channel (archived task) → still rejected (strict block).
 *   4. Missing channel → no-op (updateOne on a missing doc does not throw).
 *
 * Uses a mock Db with in-memory storage — no real MongoDB needed.
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import type { Collection, Db } from 'mongodb';
import { ChannelManager } from './channel-manager';

// ─── Mock helpers ──────────────────────────────────────────────────────────────

function createMockCollection<T = any>() {
  const store = new Map<string, T & { channelId?: string; taskId?: string }>();

  const matches = (doc: any, filter: Record<string, any>) =>
    Object.entries(filter).every(([k, v]) =>
      v && typeof v === 'object' && '$ne' in v ? doc[k] !== v.$ne : doc[k] === v,
    );

  const findOne = mock((filter: Record<string, any>) => {
    const results = [...store.values()].filter((doc) => matches(doc, filter));
    return Promise.resolve(results[0] ?? null);
  });

  const updateOne = mock(
    (filter: Record<string, any>, update: Record<string, any>) => {
      const target = [...store.values()].find((doc) => matches(doc, filter));
      if (!target) return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
      if (update.$set) {
        for (const [k, v] of Object.entries(update.$set)) {
          if (k.includes('.')) {
            // dotted path: only the one we use — metadata.name / top-level
            const [root, leaf] = k.split('.');
            (target as any)[root] = (target as any)[root] || {};
            (target as any)[root][leaf] = v;
          } else {
            (target as any)[k] = v;
          }
        }
      }
      return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
    },
  );

  return {
    store,
    findOne,
    updateOne,
    collection: {
      findOne,
      updateOne,
      insertOne: mock((doc: any) => {
        store.set(doc.channelId ?? doc.taskId ?? String(store.size), doc);
        return Promise.resolve({ acknowledged: true });
      }),
      find: () => ({ sort: () => ({ limit: () => ({ toArray: () => Promise.resolve([...store.values()]) }) }) }),
    } as unknown as Collection<T>,
  };
}

function createMockDb(collections: Record<string, ReturnType<typeof createMockCollection>>) {
  // ChannelManager/BoardService resolve collections via db.collection(name)
  const db = {
    collection: (name: string) =>
      (collections[name] ?? createMockCollection()).collection,
  } as unknown as Db;
  return { db };
}

// ChannelManager constructor: (db, providerService, idGenerator?, featureFlagService?)
const stubProviderService = {} as any;

function makeManager(collections: Record<string, ReturnType<typeof createMockCollection>>) {
  const { db } = createMockDb(collections);
  return { manager: new ChannelManager(db as any, stubProviderService) };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('ChannelManager.renameChannel — task-linked block', () => {
  let channels: ReturnType<typeof createMockCollection>;
  let tasks: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    channels = createMockCollection();
    tasks = createMockCollection();
  });

  test('renames an unlinked channel (no regression)', async () => {
    channels.store.set('ch_free', { channelId: 'ch_free', metadata: { name: 'Old name' } } as any);

    const { manager } = makeManager({ channels, tasks });
    await manager.renameChannel('ch_free', 'New name');

    const doc = channels.store.get('ch_free') as any;
    expect(doc.metadata.name).toBe('New name');
    expect(doc.updatedAt).toBeString();
  });

  test('rejects renaming a task-linked channel with the task title in the error', async () => {
    channels.store.set('ch_task', { channelId: 'ch_task', metadata: { name: 'Task conv' } } as any);
    tasks.store.set('task_1', { taskId: 'task_1', channelId: 'ch_task', title: 'Fix the login bug' } as any);

    const { manager } = makeManager({ channels, tasks });

    let error: Error | undefined;
    try {
      await manager.renameChannel('ch_task', 'Another name');
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain('Fix the login bug');
    expect(error!.message).toContain('rename the task');

    // The channel must NOT have been renamed
    const doc = channels.store.get('ch_task') as any;
    expect(doc.metadata.name).toBe('Task conv');
  });

  test('rejects even when the linked task is archived (strict block)', async () => {
    channels.store.set('ch_arch', { channelId: 'ch_arch', metadata: { name: 'Archived task conv' } } as any);
    tasks.store.set('task_2', {
      taskId: 'task_2',
      channelId: 'ch_arch',
      title: 'Old archived task',
      archived: true,
    } as any);

    const { manager } = makeManager({ channels, tasks });

    let error: Error | undefined;
    try {
      await manager.renameChannel('ch_arch', 'Another name');
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeDefined();
    expect(error!.message).toContain('Old archived task');
  });

  test('rename of a missing channel is a no-op (no throw)', async () => {
    const { manager } = makeManager({ channels, tasks });
    // updateOne on a missing doc does not throw — same as before the change
    await manager.renameChannel('ch_missing', 'Whatever');
    expect(channels.store.size).toBe(0);
  });
});
