/**
 * Unit — dependency cycle detection (TER-457)
 *
 * `BoardService.detectCycle` + `addDependency` guard the board's dependency
 * graph: a cycle (A blocks B blocks … blocks A) would deadlock autoplay forever.
 * The DFS walks from the proposed edge's target back toward its source — a
 * missed cycle persists a deadlock; a false positive blocks a legal dependency.
 * These drive the algorithm directly over an in-memory tasks collection.
 */

import { describe, expect, it } from 'bun:test';
import { BoardService } from '../../../packages/backend/src/services/board-service';

const BOARD = 'board_1';

/** Build a BoardService backed by an in-memory `tasks` collection. */
function makeService(tasks: Array<{ taskId: string; boardId?: string; dependencies?: string[] }>) {
  const store = tasks.map((t) => ({ boardId: BOARD, dependencies: [], ...t }));
  const counters = { writes: 0 };
  const tasksCol = {
    find: (q: any) => ({ toArray: async () => store.filter((t) => !q?.boardId || t.boardId === q.boardId) }),
    findOne: async (q: any) => store.find((t) => t.taskId === q.taskId) ?? null,
    findOneAndUpdate: async (q: any, update: any) => {
      counters.writes++;
      const t = store.find((x) => x.taskId === q.taskId);
      if (!t) return null;
      const add = update?.$addToSet?.dependencies;
      if (add && !t.dependencies!.includes(add)) t.dependencies!.push(add);
      return t;
    },
    createIndex: async () => undefined,
  };
  const db = {
    collection: () => tasksCol, // boards/agents collections are unused by these methods
  } as any;
  return { svc: new BoardService(db), store, counters };
}

// edge A→B means "A depends on B" (A is blocked by B): tasks[A].dependencies = [B]
const dep = (taskId: string, dependencies: string[] = []) => ({ taskId, dependencies });

describe('detectCycle', () => {
  it('returns [] when the new edge creates no cycle (independent chains)', async () => {
    const { svc } = makeService([dep('A', ['B']), dep('B'), dep('C', ['D']), dep('D')]);
    // B depends on C — walking from C never reaches B.
    expect(await svc.detectCycle(BOARD, 'B', 'C')).toEqual([]);
  });

  it('detects a direct 2-cycle (A↔B)', async () => {
    const { svc } = makeService([dep('A', ['B']), dep('B')]);
    // Adding "B depends on A" closes A→B→A.
    const cycle = await svc.detectCycle(BOARD, 'B', 'A');
    expect(cycle.length).toBeGreaterThan(0);
    expect(cycle).toContain('A');
    expect(cycle).toContain('B');
  });

  it('detects a transitive cycle (A→B→C, then C→A)', async () => {
    const { svc } = makeService([dep('A', ['B']), dep('B', ['C']), dep('C')]);
    const cycle = await svc.detectCycle(BOARD, 'C', 'A');
    expect(cycle.length).toBeGreaterThan(0);
    expect(cycle).toContain('A');
    expect(cycle).toContain('B');
    expect(cycle).toContain('C');
  });

  it('does NOT flag a diamond that stays acyclic', async () => {
    // A→B, A→C, B→D, C→D. Adding D→(new leaf E) creates no cycle.
    const { svc } = makeService([
      dep('A', ['B', 'C']),
      dep('B', ['D']),
      dep('C', ['D']),
      dep('D'),
      dep('E'),
    ]);
    expect(await svc.detectCycle(BOARD, 'D', 'E')).toEqual([]);
  });

  it('detects a cycle that closes a diamond (D→A with A reachable from D)', async () => {
    const { svc } = makeService([dep('A', ['B', 'C']), dep('B', ['D']), dep('C', ['D']), dep('D')]);
    // D→A would close A→B→D→A.
    expect((await svc.detectCycle(BOARD, 'D', 'A')).length).toBeGreaterThan(0);
  });

  it('terminates on a pre-existing cycle in the graph (no infinite loop)', async () => {
    // Graph already cyclic: X→Y→X. Querying must still return, not hang.
    const { svc } = makeService([dep('X', ['Y']), dep('Y', ['X']), dep('Z')]);
    expect(await svc.detectCycle(BOARD, 'Z', 'X')).toEqual([]);
  });
});

describe('addDependency — guards', () => {
  it('rejects a self-dependency before any DB work', async () => {
    const { svc } = makeService([dep('A')]);
    await expect(svc.addDependency('A', 'A', 'actor')).rejects.toThrow(/CIRCULAR_DEPENDENCY/);
  });

  it('is idempotent when the dependency already exists — early return, no DB write', async () => {
    const { svc, store, counters } = makeService([dep('A', ['B']), dep('B')]);
    const result = await svc.addDependency('A', 'B', 'actor');
    expect(result.dependencies).toEqual(['B']); // unchanged, no duplicate
    expect(store.find((t) => t.taskId === 'A')!.dependencies).toEqual(['B']);
    // The early-return short-circuits before any write (DB Writes Are Contracts).
    expect(counters.writes).toBe(0);
  });

  it('throws CIRCULAR_DEPENDENCY when the edge would close a cycle', async () => {
    const { svc, store } = makeService([dep('A', ['B']), dep('B')]);
    await expect(svc.addDependency('B', 'A', 'actor')).rejects.toThrow(/CIRCULAR_DEPENDENCY/);
    // The illegal edge must NOT have been persisted.
    expect(store.find((t) => t.taskId === 'B')!.dependencies).toEqual([]);
  });

  it('persists a legal dependency', async () => {
    const { svc, store } = makeService([dep('A'), dep('B')]);
    await svc.addDependency('A', 'B', 'actor');
    expect(store.find((t) => t.taskId === 'A')!.dependencies).toEqual(['B']);
  });

  it('rejects a cross-board dependency', async () => {
    const { svc } = makeService([dep('A'), { taskId: 'X', boardId: 'board_2', dependencies: [] }]);
    await expect(svc.addDependency('A', 'X', 'actor')).rejects.toThrow(/[Cc]ross-board/);
  });
});
