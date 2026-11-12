/**
 * ReviewClaimService — single-flight claims for review actions (AC-1..AC-3).
 *
 * The whole point of the claim is the ATOMICITY of the conditioned
 * `findOneAndUpdate`: when N sessions race, exactly one filter matches. A
 * naive mock that always "succeeds" would test nothing, so this suite uses a
 * faithful in-memory collection that reproduces Mongo's semantics:
 *   - the filter is evaluated against the CURRENT document,
 *   - the update is applied only if the filter matches,
 *   - and (crucially for the race test) the whole find+update is serialized
 *     through a mutex so concurrent calls behave like Mongo's atomic op.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { ReviewClaimService } from '../../src/services/review-claim-service';
import type { ReviewClaim, Task } from '../../src/types/database';

const TASK_ID = 'task_review_1';
const AGENT = 'agent_alice';
const OTHER_AGENT = 'agent_nira';
const CH_A = 'ch_session_A';
const CH_B = 'ch_session_B';

// ─── Faithful in-memory Mongo collection ────────────────────────────────────
//
// Supports exactly the operations ReviewClaimService uses:
//   findOneAndUpdate(filter, update, { returnDocument })
//   updateOne(filter, update)
//   findOne(filter, { projection })
//
// The filter evaluator understands the specific operators the service uses:
// $or, $exists, $lte on dotted paths, and plain equality (incl. dotted paths).
class FakeTasks {
  private doc: Task;
  // Serializes find+update so concurrent calls are atomic like Mongo.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(doc: Task) {
    this.doc = doc;
  }

  private get(path: string): unknown {
    return path.split('.').reduce((o: any, k) => (o == null ? o : o[k]), this.doc as any);
  }

  private matches(filter: any): boolean {
    for (const [key, cond] of Object.entries(filter)) {
      if (key === '$or') {
        if (!(cond as any[]).some((sub) => this.matches(sub))) return false;
        continue;
      }
      const val = this.get(key);
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>;
        if ('$exists' in c) {
          const exists = val !== undefined;
          if (exists !== c.$exists) return false;
        }
        if ('$lte' in c) {
          if (!(typeof val === 'string' && val <= (c.$lte as string))) return false;
        }
        // plain object equality not needed beyond operators here
        if (!('$exists' in c) && !('$lte' in c)) {
          if (val !== cond) return false;
        }
      } else {
        if (val !== cond) return false;
      }
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
    for (let i = 0; i < keys.length - 1; i++) {
      if (o == null) return;
      o = o[keys[i]];
    }
    if (o) delete o[keys[keys.length - 1]];
  }

  private applyUpdate(update: any): void {
    if (update.$set) {
      for (const [k, v] of Object.entries(update.$set)) this.setPath(k, v);
    }
    if (update.$unset) {
      for (const k of Object.keys(update.$unset)) this.unsetPath(k);
    }
  }

  findOneAndUpdate(filter: any, update: any, opts: any): Promise<Task | null> {
    const run = async () => {
      if (!this.matches(filter)) return null;
      this.applyUpdate(update);
      return opts?.returnDocument === 'after' ? this.doc : this.doc;
    };
    const result = this.chain.then(run);
    this.chain = result.catch(() => {});
    return result;
  }

  async updateOne(filter: any, update: any): Promise<{ modifiedCount: number }> {
    if (!this.matches(filter)) return { modifiedCount: 0 };
    this.applyUpdate(update);
    return { modifiedCount: 1 };
  }

  async findOne(filter: any, _opts?: any): Promise<Task | null> {
    return this.matches(filter) ? this.doc : null;
  }

  getDoc(): Task {
    return this.doc;
  }
}

function makeTask(claim?: ReviewClaim): Task {
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
    ...(claim ? { reviewClaims: { [claim.agentId]: claim } } : {}),
  } as Task;
}

function makeService(doc: Task): { svc: ReviewClaimService; fake: FakeTasks } {
  const fake = new FakeTasks(doc);
  const db = { collection: () => fake } as any;
  const svc = new ReviewClaimService(db);
  return { svc, fake };
}

function expiredClaim(agentId: string, channelId: string): ReviewClaim {
  const past = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
  return {
    agentId,
    channelId,
    claimedAt: past.toISOString(),
    expiresAt: new Date(past.getTime() + 15 * 60 * 1000).toISOString(), // expired 45m ago
  };
}

function liveClaim(agentId: string, channelId: string): ReviewClaim {
  const now = new Date();
  return {
    agentId,
    channelId,
    claimedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
  };
}

// =============================================================================

 describe('ReviewClaimService', () => {
  beforeEach(() => {
    delete process.env.BOARD_REVIEW_CLAIM_TTL_MS;
  });

  it('AC-1: two concurrent sessions of the SAME agent — exactly one acquires the claim', async () => {
    const { svc } = makeService(makeTask());

    // Simulate the race: both sessions fire tryAcquire "at the same time".
    const [a, b] = await Promise.all([
      svc.tryAcquire(TASK_ID, AGENT, CH_A),
      svc.tryAcquire(TASK_ID, AGENT, CH_B),
    ]);

    const acquired = [a, b].filter((r) => r.acquired);
    const skipped = [a, b].filter((r) => !r.acquired);

    expect(acquired.length).toBe(1);
    expect(skipped.length).toBe(1);
    expect(skipped[0].reason).toContain('claimed by session');
  });

  it('AC-1: the loser sees the winner channelId in the reason (skipped log)', async () => {
    const { svc } = makeService(makeTask());
    const winner = await svc.tryAcquire(TASK_ID, AGENT, CH_A);
    expect(winner.acquired).toBe(true);

    const loser = await svc.tryAcquire(TASK_ID, AGENT, CH_B);
    expect(loser.acquired).toBe(false);
    expect(loser.claim?.channelId).toBe(CH_A);
    expect(loser.reason).toContain(CH_A);
  });

  it('AC-2: an expired claim is stealable by a new session', async () => {
    const { svc, fake } = makeService(makeTask(expiredClaim(AGENT, CH_A)));

    const stealer = await svc.tryAcquire(TASK_ID, AGENT, CH_B);
    expect(stealer.acquired).toBe(true);
    expect(fake.getDoc().reviewClaims?.[AGENT]?.channelId).toBe(CH_B);
  });

  it('AC-2: a LIVE claim is NOT stealable', async () => {
    const { svc } = makeService(makeTask(liveClaim(AGENT, CH_A)));

    const stealer = await svc.tryAcquire(TASK_ID, AGENT, CH_B);
    expect(stealer.acquired).toBe(false);
  });

  it('AC-2: TTL is configurable via BOARD_REVIEW_CLAIM_TTL_MS', async () => {
    process.env.BOARD_REVIEW_CLAIM_TTL_MS = '60000'; // 1 min
    const { svc } = makeService(makeTask());
    const res = await svc.tryAcquire(TASK_ID, AGENT, CH_A);
    expect(res.acquired).toBe(true);
    const delta = new Date(res.claim!.expiresAt).getTime() - new Date(res.claim!.claimedAt).getTime();
    expect(delta).toBe(60000);
  });

  it('AC-3: DIFFERENT agents each hold their own claim on the same task', async () => {
    // Agent A (alice) holds a live claim. Agent B (nira) must still acquire —
    // the claim is per (taskId, agentId), not global.
    const { svc, fake } = makeService(makeTask(liveClaim(AGENT, CH_A)));

    const other = await svc.tryAcquire(TASK_ID, OTHER_AGENT, CH_B);
    expect(other.acquired).toBe(true);
    expect(fake.getDoc().reviewClaims?.[OTHER_AGENT]?.agentId).toBe(OTHER_AGENT);
    // Original agent's claim is untouched (independent slot).
    expect(fake.getDoc().reviewClaims?.[AGENT]?.channelId).toBe(CH_A);
  });

  it('same channel re-entering is idempotent (note then move does not self-block)', async () => {
    const { svc } = makeService(makeTask());
    const first = await svc.tryAcquire(TASK_ID, AGENT, CH_A);
    expect(first.acquired).toBe(true);

    // Same session re-acquires (e.g. posted the note, now moving the task).
    const second = await svc.tryAcquire(TASK_ID, AGENT, CH_A);
    expect(second.acquired).toBe(true);
  });

  it('release only works for the exact claiming channel (late loser release is a no-op)', async () => {
    const { svc, fake } = makeService(makeTask());
    await svc.tryAcquire(TASK_ID, AGENT, CH_A);

    // A different channel tries to release → must NOT release.
    const wrongRelease = await svc.release(TASK_ID, AGENT, CH_B);
    expect(wrongRelease).toBe(false);
    expect(fake.getDoc().reviewClaims?.[AGENT]?.channelId).toBe(CH_A);

    // The rightful owner releases → claim cleared.
    const rightRelease = await svc.release(TASK_ID, AGENT, CH_A);
    expect(rightRelease).toBe(true);
    expect(fake.getDoc().reviewClaims?.[AGENT]).toBeUndefined();
  });

  it('after release, a new session can acquire again (re-review)', async () => {
    const { svc } = makeService(makeTask());
    await svc.tryAcquire(TASK_ID, AGENT, CH_A);
    await svc.release(TASK_ID, AGENT, CH_A);

    const again = await svc.tryAcquire(TASK_ID, AGENT, CH_B);
    expect(again.acquired).toBe(true);
  });

  it('AC-1 (d): the losing session does not throw — it gets a clean skip result', async () => {
    const { svc } = makeService(makeTask(liveClaim(AGENT, CH_A)));
    // Must resolve, not reject.
    const res = await svc.tryAcquire(TASK_ID, AGENT, CH_B);
    expect(res.acquired).toBe(false);
    expect(typeof res.reason).toBe('string');
  });
});
