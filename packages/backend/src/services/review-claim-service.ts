/**
 * ReviewClaimService — single-flight claims for review actions on board tasks.
 *
 * ─── Problem ────────────────────────────────────────────────────────────────
 * The platform allows multiple concurrent sessions of the same agent. When a
 * board event arrives (e.g. `task_moved` → Review), EVERY live session of the
 * subscribed agent receives it and each independently executes the same
 * reaction: verify, post a review note, move the task. Result: duplicate and
 * even contradictory review notes on the board (incidents T-REM-10, Transfer
 * A/B, T-REM-14 — 27+ duplicate notes measured on 2026-10-19).
 *
 * ─── Solution ───────────────────────────────────────────────────────────────
 * A per-agent claim embedded in the task document: `reviewClaims[agentId]`.
 * Before executing a review action (review note or the column move that
 * follows), a session must hold the claim for (taskId, agentId). Acquisition
 * is a single `findOneAndUpdate` with a conditioned filter on the dotted path
 * `reviewClaims.<agentId>` — MongoDB's atomicity IS the mutex; no distributed
 * lock needed.
 *
 * - Sessions that lose the race see a live claim owned by another channel and
 *   skip the action (logged as 'skipped: claimed by session X').
 * - The claim expires after a TTL (default 15 min, configurable via env
 *   `BOARD_REVIEW_CLAIM_TTL_MS`) so a session that dies mid-review doesn't
 *   block the task forever — the next session steals the expired claim.
 * - The claim is per (taskId, agentId): different agents reviewing the same
 *   task each hold their own claim under their own key (AC-3 — multi-agent
 *   flow unaffected).
 * - Released when the review's terminal action (the column move) completes,
 *   or by expiry.
 *
 * ─── What this is NOT ───────────────────────────────────────────────────────
 * This guards REVIEW actions only (opt-in via `reviewAction: true` from the
 * board-runner tools). Normal progress reporting by a runner on its own
 * in-progress task does NOT go through the claim — that would be a regression.
 * Cross-agent EXECUTION claims (incident 5, two agents building the same
 * task) are a different mechanism — see the worktree/execution-claim proposal
 * in docs/specs/20261019_single-flight-review-claims.md.
 */

import type { Collection, Db } from 'mongodb';
import { COLLECTIONS, collection } from '../db';
import type { ReviewClaim, Task } from '../types/database';

/** Default claim TTL: 15 minutes. Override with env BOARD_REVIEW_CLAIM_TTL_MS. */
const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000;

export interface ClaimResult {
  /** Whether the caller acquired (or already held) the claim */
  acquired: boolean;
  /** The claim now held by this agent on the task (caller's if acquired) */
  claim?: ReviewClaim;
  /** Human-readable reason when acquisition failed */
  reason?: string;
}

export class ReviewClaimService {
  private tasks: Collection<Task>;
  private readonly ttlMs: number;

  constructor(private db: Db) {
    // GOV-1: access via the registry helper (not a raw db.collection literal),
    // and the collection is `tasks` (COLLECTIONS.tasks), not 'board_tasks'.
    this.tasks = collection<Task>(db, COLLECTIONS.tasks);
    const envTtl = Number(process.env.BOARD_REVIEW_CLAIM_TTL_MS);
    this.ttlMs = Number.isFinite(envTtl) && envTtl > 0 ? envTtl : DEFAULT_CLAIM_TTL_MS;
  }

  /**
   * Try to acquire the review claim for (taskId, agentId) on behalf of a
   * session (channelId).
   *
   * Atomic semantics — exactly one of these `findOneAndUpdate` calls wins
   * when N sessions of the SAME agent race, because the filter on
   * `reviewClaims.<agentId>` only matches when:
   *   a) this agent has no claim yet, OR
   *   b) this agent's existing claim has expired (stealable), OR
   *   c) this agent's existing claim is already held by THIS SAME channel
   *      (idempotent re-entry — the same session posting its note and then
   *      moving the task must not block itself).
   *
   * A live claim held by a DIFFERENT channel of the same agent does NOT
   * match → acquisition fails → the caller skips.
   *
   * A DIFFERENT agent's claim lives under a different key and never
   * interferes (AC-3).
   */
  async tryAcquire(taskId: string, agentId: string, channelId: string): Promise<ClaimResult> {
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();

    const claim: ReviewClaim = {
      agentId,
      channelId,
      claimedAt: nowIso,
      expiresAt,
    };

    // Dotted path for this agent's claim slot.
    const slot = `reviewClaims.${agentId}`;

    const updated = await this.tasks.findOneAndUpdate(
      {
        taskId,
        $or: [
          { [slot]: { $exists: false } },
          { [slot]: null },
          // This agent's claim expired → stealable
          { [`${slot}.expiresAt`]: { $lte: nowIso } },
          // Same channel re-entering (idempotent: note then move)
          { [`${slot}.channelId`]: channelId },
        ],
      },
      { $set: { [slot]: claim } },
      { returnDocument: 'after' },
    );

    if (updated) {
      return { acquired: true, claim };
    }

    // Lost the race — read the live claim to report who holds it.
    const task = await this.tasks.findOne(
      { taskId },
      { projection: { reviewClaims: 1 } },
    );
    const live = task?.reviewClaims?.[agentId];
    return {
      acquired: false,
      claim: live,
      reason: live
        ? `claimed by session ${live.channelId} (agent ${live.agentId}) until ${live.expiresAt}`
        : 'claim race lost',
    };
  }

  /**
   * Release the claim, but ONLY if it is still held by this exact channel.
   * A session must never release another session's claim (e.g. after a steal,
   * the original loser's late release must be a no-op).
   */
  async release(taskId: string, agentId: string, channelId: string): Promise<boolean> {
    const slot = `reviewClaims.${agentId}`;
    const res = await this.tasks.updateOne(
      {
        taskId,
        [`${slot}.channelId`]: channelId,
      },
      { $unset: { [slot]: '' } },
    );
    return res.modifiedCount > 0;
  }

  /** Read the current claim held by an agent on a task (observability). */
  async getClaim(taskId: string, agentId: string): Promise<ReviewClaim | undefined> {
    const task = await this.tasks.findOne(
      { taskId },
      { projection: { reviewClaims: 1 } },
    );
    return task?.reviewClaims?.[agentId];
  }
}
