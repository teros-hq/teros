/**
 * Manager-path single-flight review claim guard (AC-1 end-to-end).
 *
 * Alice's review (23:01Z) found the original implementation only guarded the
 * board-RUNNER path, while every measured duplicate-review incident came from
 * checker sessions using the board-MANAGER tools (move_task / add_progress_note).
 * This suite exercises the manager query handlers directly with a real
 * ReviewClaimService over a faithful in-memory Mongo mock, and asserts that
 * two concurrent sessions of the SAME agent produce exactly ONE write.
 */

import { describe, expect, it, mock } from 'bun:test';
import { handleBoardReadAction } from '../../src/services/mca-connection-manager.queries-board-read';
import { handleBoardWriteAction } from '../../src/services/mca-connection-manager.queries-board-write';
import { ReviewClaimService } from '../../src/services/review-claim-service';
import type { ReviewClaim, Task } from '../../src/types/database';

const TASK_ID = 'task_review_mgr';
const AGENT = 'agent_alice';
const CH_A = 'ch_session_A';
const CH_B = 'ch_session_B';

// ─── Faithful in-memory Mongo collection (same semantics as the claim test) ─
class FakeTasks {
  private doc: Task;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(doc: Task) { this.doc = doc; }
  private get(path: string): unknown {
    return path.split('.').reduce((o: any, k) => (o == null ? o : o[k]), this.doc as any);
  }
  private matches(filter: any): boolean {
    for (const [key, cond] of Object.entries(filter)) {
      if (key === '$or') {
        if (!(cond as any[]).some((s) => this.matches(s))) return false;
        continue;
      }
      const val = this.get(key);
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>;
        if ('$exists' in c) { if ((val !== undefined) !== c.$exists) return false; }
        if ('$lte' in c) { if (!(typeof val === 'string' && val <= (c.$lte as string))) return false; }
        if (!('$exists' in c) && !('$lte' in c)) { if (val !== cond) return false; }
      } else if (val !== cond) return false;
    }
    return true;
  }
  private setPath(path: string, value: unknown): void {
    const keys = path.split('.');
    let o: any = this.doc;
    for (let i = 0; i < keys.length - 1; i++) {
      if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
      o = o[keys[i]];
    }
    o[keys[keys.length - 1]] = value;
  }
  private unsetPath(path: string): void {
    const keys = path.split('.');
    let o: any = this.doc;
    for (let i = 0; i < keys.length - 1; i++) { if (o == null) return; o = o[keys[i]]; }
    if (o) delete o[keys[keys.length - 1]];
  }
  private applyUpdate(update: any): void {
    if (update.$set) for (const [k, v] of Object.entries(update.$set)) this.setPath(k, v);
    if (update.$unset) for (const k of Object.keys(update.$unset)) this.unsetPath(k);
  }
  findOneAndUpdate(filter: any, update: any, opts: any): Promise<Task | null> {
    const run = async () => {
      if (!this.matches(filter)) return null;
      this.applyUpdate(update);
      return this.doc;
    };
    const result = this.chain.then(run);
    this.chain = result.catch(() => {});
    return result;
  }
  async updateOne(filter: any, update: any) {
    if (!this.matches(filter)) return { modifiedCount: 0 };
    this.applyUpdate(update);
    return { modifiedCount: 1 };
  }
  async findOne(filter: any) { return this.matches(filter) ? this.doc : null; }
}

function makeTask(): Task {
  return {
    taskId: TASK_ID,
    boardId: 'board_1',
    columnId: 'col_review',
    position: 0,
    title: 'Review me',
    priority: 'high',
    archived: false,
    tags: [],
    assignedAgentId: AGENT,
    running: false,
    dependencies: [],
    progressNotes: [],
    activity: [],
    createdBy: 'agent_x',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Task;
}

function makeBoardService(task: Task, counters: { moves: number; notes: number }) {
  const board = { boardId: 'board_1', projectId: 'proj_1', columns: [
    { columnId: 'col_review', name: 'Review', slug: 'review' },
    { columnId: 'col_done', name: 'Done', slug: 'done' },
  ] };
  return {
    moveTask: mock(async () => { counters.moves++; return { ...task, columnId: 'col_done' }; }),
    addProgressNote: mock(async () => { counters.notes++; return task; }),
    getBoard: mock(async () => board),
    getProject: mock(async () => ({ projectId: 'proj_1', workspaceId: 'work_1' })),
    getTask: mock(async () => task),
  };
}

function makeConn(channelId: string): any {
  return { currentChannelId: channelId, currentAgentId: AGENT };
}

function makeCtx(boardService: any, svc: ReviewClaimService): any {
  return { boardService, reviewClaimService: svc, pubSubService: undefined, actionBridgeManager: undefined };
}

// =============================================================================

describe('board-manager review claim guard', () => {
  it('AC-1: two concurrent sessions moving the same task → exactly ONE move', async () => {
    const fake = new FakeTasks(makeTask());
    const svc = new ReviewClaimService({ collection: () => fake } as any);
    const counters = { moves: 0, notes: 0 };
    const ctx = makeCtx(makeBoardService(makeTask(), counters), svc);

    const params = { taskId: TASK_ID, columnId: 'col_done', reviewAction: true };
    const [rA, rB] = await Promise.all([
      handleBoardReadAction(ctx, 'move_task', params, 'user_1', AGENT, makeConn(CH_A)),
      handleBoardReadAction(ctx, 'move_task', params, 'user_1', AGENT, makeConn(CH_B)),
    ]);

    expect(counters.moves).toBe(1); // exactly one session moved the task
    const results = [rA, rB] as any[];
    const skips = results.filter((r) => r && r.skipped === true);
    const moved = results.filter((r) => r && r.task);
    expect(skips.length).toBe(1);
    expect(moved.length).toBe(1);
    // The loser either sees the winner's live claim ('claimed by session X')
    // or loses the atomic race before the winner's $set is visible ('claim race lost').
    expect(String(skips[0].reason)).toMatch(/claimed by|claim race lost/);
  });

  it('AC-1: two concurrent sessions posting a review note → exactly ONE note', async () => {
    const fake = new FakeTasks(makeTask());
    const svc = new ReviewClaimService({ collection: () => fake } as any);
    const counters = { moves: 0, notes: 0 };
    const ctx = makeCtx(makeBoardService(makeTask(), counters), svc);

    const params = { taskId: TASK_ID, text: 'verified OK', reviewAction: true };
    const [rA, rB] = await Promise.all([
      handleBoardWriteAction(ctx, 'add_progress_note', params, 'user_1', AGENT, makeConn(CH_A)),
      handleBoardWriteAction(ctx, 'add_progress_note', params, 'user_1', AGENT, makeConn(CH_B)),
    ]);

    expect(counters.notes).toBe(1);
    const results = [rA, rB] as any[];
    expect(results.filter((r) => r && r.skipped === true).length).toBe(1);
    expect(results.filter((r) => r && r.task).length).toBe(1);
  });

  it('zero regression (AC-3): in_progress task without reviewAction → guard is a no-op (both write)', async () => {
    // v2: the guard now ALSO fires on review-column tasks without the flag
    // (slug inference — incident #23 fix). The real AC-3 is about NORMAL
    // progress reporting on an in-progress task, which must stay unguarded.
    // Put the task in a non-review column for this test.
    const inProgressTask = { ...makeTask(), columnId: 'col_in_progress' };
    const fake = new FakeTasks(inProgressTask);
    const svc = new ReviewClaimService({ collection: () => fake } as any);
    const counters = { moves: 0, notes: 0 };
    const boardSvc = makeBoardService(inProgressTask, counters);
    // Extend the board with an in_progress column so the slug lookup works.
    const origGetBoard = boardSvc.getBoard;
    boardSvc.getBoard = async () => ({
      boardId: 'board_1',
      projectId: 'proj_1',
      columns: [
        { columnId: 'col_in_progress', name: 'In Progress', slug: 'in_progress' },
        { columnId: 'col_review', name: 'Review', slug: 'review' },
        { columnId: 'col_done', name: 'Done', slug: 'done' },
      ],
    }) as any;
    const ctx = makeCtx(boardSvc, svc);

    const params = { taskId: TASK_ID, text: 'normal progress', /* no reviewAction */ };
    await handleBoardWriteAction(ctx, 'add_progress_note', params, 'user_1', AGENT, makeConn(CH_A));
    await handleBoardWriteAction(ctx, 'add_progress_note', params, 'user_1', AGENT, makeConn(CH_B));
    expect(counters.notes).toBe(2); // normal progress reporting is NOT guarded
  });

  it('single-session safe: no reviewClaimService wired → guard is a no-op', async () => {
    const counters = { moves: 0, notes: 0 };
    const ctx: any = { boardService: makeBoardService(makeTask(), counters) }; // no reviewClaimService
    const params = { taskId: TASK_ID, columnId: 'col_done', reviewAction: true };
    const r = await handleBoardReadAction(ctx, 'move_task', params, 'user_1', AGENT, makeConn(CH_A));
    expect(counters.moves).toBe(1);
    expect((r as any).task).toBeTruthy();
  });
});
