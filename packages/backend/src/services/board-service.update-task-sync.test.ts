/**
 * Unit tests for BoardService.updateTask — linked conversation title sync.
 *
 * Invariant: task title = linked conversation title (task.channelId ↔
 * channels.metadata.name). When a task with a linked channel is renamed,
 * the channel's title must follow in the same operation.
 *
 * Coverage:
 *   1. Title change + linked channel → channels.metadata.name updated.
 *   2. Title change + NO linked channel → no channel update.
 *   3. Non-title update + linked channel → no channel update.
 *   4. Same title (no-op rename) → no channel update.
 *
 * Uses a mock Db with in-memory storage — no real MongoDB needed.
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test';
import type { Collection, Db } from 'mongodb';
import { BoardService } from './board-service';

// ─── Mock helpers ──────────────────────────────────────────────────────────────

interface MockDoc {
  taskId?: string;
  channelId?: string;
  boardId?: string;
  projectId?: string;
  workspaceId?: string;
  title?: string;
  [key: string]: any;
}

function createMockCollection(docs: MockDoc[] = []) {
  const store = new Map<string, MockDoc>();
  const keyOf = (d: MockDoc) => d.taskId ?? d.channelId ?? d.boardId ?? d.projectId ?? String(store.size);
  docs.forEach((d) => store.set(keyOf(d), d));

  const matches = (doc: any, filter: Record<string, any>) =>
    Object.entries(filter).every(([k, v]) => doc[k] === v);

  const findOne = mock((filter: Record<string, any>) => {
    const results = [...store.values()].filter((doc) => matches(doc, filter));
    // Return a shallow clone — the real driver deserializes each doc into a
    // fresh object, so the pre-update snapshot and the updated result differ.
    return Promise.resolve(results[0] ? { ...results[0] } : null);
  });

  const applySet = (target: any, $set: Record<string, any>) => {
    for (const [k, v] of Object.entries($set)) {
      if (k.includes('.')) {
        const [root, leaf] = k.split('.');
        target[root] = target[root] || {};
        target[root][leaf] = v;
      } else {
        target[k] = v;
      }
    }
  };

  const updateOne = mock((filter: Record<string, any>, update: Record<string, any>) => {
    const target = [...store.values()].find((doc) => matches(doc, filter));
    if (!target) return Promise.resolve({ matchedCount: 0, modifiedCount: 0 });
    if (update.$set) applySet(target, update.$set);
    return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
  });

  const findOneAndUpdate = mock(
    (filter: Record<string, any>, update: Record<string, any>, _opts?: any) => {
      const target = [...store.values()].find((doc) => matches(doc, filter));
      if (!target) return Promise.resolve(null);
      if (update.$set) applySet(target, update.$set);
      if (update.$push?.activity?.$each) {
        target.activity = [...(target.activity || []), ...update.$push.activity.$each];
      }
      return Promise.resolve(target);
    },
  );

  const find = mock((filter: Record<string, any>) => {
    const results = [...store.values()].filter((doc) => matches(doc, filter));
    return { toArray: () => Promise.resolve(results) };
  });

  return {
    store,
    findOne,
    updateOne,
    findOneAndUpdate,
    find,
    collection: {
      findOne,
      updateOne,
      findOneAndUpdate,
      find,
      insertOne: mock((doc: MockDoc) => {
        store.set(keyOf(doc), doc);
        return Promise.resolve({ acknowledged: true });
      }),
      createIndex: mock(() => Promise.resolve('idx')),
    } as unknown as Collection,
  };
}

function makeService() {
  const tasks = createMockCollection();
  const boards = createMockCollection();
  const projects = createMockCollection();
  const channels = createMockCollection();

  const db = {
    collection: mock((name: string) => {
      switch (name) {
        case 'tasks': return tasks.collection;
        case 'boards': return boards.collection;
        case 'projects': return projects.collection;
        case 'channels': return channels.collection;
        default: return createMockCollection().collection;
      }
    }),
  } as unknown as Db;

  return { service: new BoardService(db), tasks, boards, projects, channels };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('BoardService.updateTask — linked conversation title sync', () => {
  let ctx: ReturnType<typeof makeService>;

  beforeEach(() => {
    ctx = makeService();
    // Board + project so event recording finds them (or fails silently)
    ctx.boards.store.set('board_1', { boardId: 'board_1', projectId: 'proj_1' } as MockDoc);
    ctx.projects.store.set('proj_1', { projectId: 'proj_1', workspaceId: 'ws_1' } as MockDoc);
  });

  test('renaming a task with a linked channel renames the channel title too', async () => {
    ctx.tasks.store.set('task_1', {
      taskId: 'task_1',
      boardId: 'board_1',
      channelId: 'ch_1',
      title: 'Old task title',
    } as MockDoc);
    ctx.channels.store.set('ch_1', { channelId: 'ch_1', metadata: { name: 'Old task title' } } as MockDoc);

    const result = await ctx.service.updateTask('task_1', 'user_1', { title: 'New task title' } as any);

    expect(result?.title).toBe('New task title');
    const channel = ctx.channels.store.get('ch_1') as any;
    expect(channel.metadata.name).toBe('New task title');
    expect(channel.updatedAt).toBeString();
  });

  test('renaming a task with NO linked channel leaves channels untouched', async () => {
    ctx.tasks.store.set('task_2', {
      taskId: 'task_2',
      boardId: 'board_1',
      title: 'Old title',
    } as MockDoc);
    ctx.channels.store.set('ch_x', { channelId: 'ch_x', metadata: { name: 'Unrelated' } } as MockDoc);

    await ctx.service.updateTask('task_2', 'user_1', { title: 'New title' } as any);

    const channel = ctx.channels.store.get('ch_x') as any;
    expect(channel.metadata.name).toBe('Unrelated');
    expect(ctx.channels.updateOne).not.toHaveBeenCalled();
  });

  test('non-title update does not touch the linked channel', async () => {
    ctx.tasks.store.set('task_3', {
      taskId: 'task_3',
      boardId: 'board_1',
      channelId: 'ch_3',
      title: 'Stable title',
      priority: 'medium',
    } as MockDoc);
    ctx.channels.store.set('ch_3', { channelId: 'ch_3', metadata: { name: 'Stable title' } } as MockDoc);

    await ctx.service.updateTask('task_3', 'user_1', { priority: 'high' } as any);

    const channel = ctx.channels.store.get('ch_3') as any;
    expect(channel.metadata.name).toBe('Stable title');
    expect(ctx.channels.updateOne).not.toHaveBeenCalled();
  });

  test('renaming a task to the SAME title does not touch the linked channel', async () => {
    ctx.tasks.store.set('task_4', {
      taskId: 'task_4',
      boardId: 'board_1',
      channelId: 'ch_4',
      title: 'Same title',
    } as MockDoc);
    ctx.channels.store.set('ch_4', { channelId: 'ch_4', metadata: { name: 'Same title' } } as MockDoc);

    await ctx.service.updateTask('task_4', 'user_1', { title: 'Same title' } as any);

    expect(ctx.channels.updateOne).not.toHaveBeenCalled();
  });
});
