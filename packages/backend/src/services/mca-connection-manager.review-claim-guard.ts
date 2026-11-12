/**
 * Single-flight review claim guard — shared by the board-runner and
 * board-manager query handlers.
 *
 * When a board event (e.g. task_moved → Review) fans out to N concurrent
 * sessions of the same agent, each session independently tries to post its
 * review note and move the task. This guard makes exactly ONE of them win:
 * the first to acquire the task's `reviewClaim` proceeds; the rest skip with
 * a structured `{ skipped: true, reason }` result instead of writing.
 *
 * ─── Adoption (v2, incident #23) ────────────────────────────────────────────
 * The guard applies when EITHER:
 *   (a) the caller passes `reviewAction: true` explicitly (opt-in, kept for
 *       forcing the guard in non-review contexts), OR
 *   (b) the task is CURRENTLY in a column whose slug is 'review' (server-side
 *       inference — the common case after a task_moved → Review fan-out).
 * Normal progress reporting on an in-progress task (slug ≠ 'review', no flag)
 * does NOT go through the claim (AC-3 — that would be a regression).
 *
 * ─── Session identity (v2, incident #23) ────────────────────────────────────
 * The session identifier resolves in this order:
 *   1. `params.callerChannelId` — explicit per-call identity (preferred; the
 *      MCA tools inject it from their per-session execution context).
 *   2. `connection.currentChannelId` — legacy mutable state on the shared
 *      MCA connection. Racy under parallel sessions (last setContext wins)
 *      and often unset for HTTP-transport MCAs — kept only as a fallback.
 *   3. A per-call UUID (`anonymous-<uuid>`) — NEVER the constant string
 *      'unknown-channel'. The pre-v2 fallback collapsed every unidentified
 *      session onto the same key, and the idempotent re-entry clause in
 *      ReviewClaimService.tryAcquire (`slot.channelId === channelId`) then
 *      let ALL of them acquire. A unique-per-call identity is fail-closed:
 *      unidentified sessions can never match each other's claim, so at most
 *      one of them wins the race.
 *
 * See docs/specs/20261019_single-flight-review-claims.md for the full design.
 */

import { randomUUID } from 'node:crypto';
import type { QueryHandlerContext, ActiveConnection } from './mca-connection-manager.types';

export interface ReviewClaimSkip {
  skipped: true;
  reason: string;
  claim: unknown;
}

/**
 * Resolve the calling session's channel identity. Never returns a constant:
 * unidentified calls get a unique-per-invocation id so they cannot collide
 * with each other inside the claim's idempotent re-entry clause.
 */
function resolveSessionChannelId(
  connection: ActiveConnection,
  params: Record<string, unknown>,
): { channelId: string; source: 'param' | 'connection' | 'generated' } {
  const fromParam = params.callerChannelId as string | undefined;
  if (typeof fromParam === 'string' && fromParam.length > 0) {
    return { channelId: fromParam, source: 'param' };
  }
  if (typeof connection.currentChannelId === 'string' && connection.currentChannelId.length > 0) {
    return { channelId: connection.currentChannelId, source: 'connection' };
  }
  return { channelId: `anonymous-${randomUUID()}`, source: 'generated' };
}

/**
 * Decide whether the guard applies to this call. True when the caller passed
 * `reviewAction: true`, or when the task's current column slug is 'review'.
 * Fails open (false) when the task/board cannot be read — a broken slug
 * lookup must not start claiming on every progress note.
 */
async function shouldApplyGuard(
  ctx: QueryHandlerContext,
  taskId: string,
  params: Record<string, unknown>,
): Promise<boolean> {
  if (params.reviewAction === true) return true;
  if (!ctx.boardService) return false;
  try {
    const task = await ctx.boardService.getTask(taskId);
    if (!task) return false;
    const board = await ctx.boardService.getBoard(task.boardId);
    const column = board?.columns?.find((c: any) => c.columnId === task.columnId);
    return column?.slug === 'review';
  } catch (err) {
    console.warn(`[ReviewClaim] shouldApplyGuard: failed to resolve column slug for task ${taskId}:`, err);
    return false;
  }
}

/**
 * Try to acquire the review claim for (taskId, agentId) on behalf of the
 * calling session. Returns null when the caller may proceed (either it won
 * the claim, or the guard does not apply), or a ReviewClaimSkip when another
 * session already holds a live claim.
 */
export async function guardReviewClaim(
  ctx: QueryHandlerContext,
  connection: ActiveConnection,
  action: string,
  taskId: string,
  agentId: string,
  params: Record<string, unknown>,
): Promise<ReviewClaimSkip | null> {
  if (!ctx.reviewClaimService) return null; // service not wired → no-op (single-session safe)
  if (!(await shouldApplyGuard(ctx, taskId, params))) return null;

  const { channelId, source } = resolveSessionChannelId(connection, params);
  if (source === 'generated') {
    console.warn(
      `[ReviewClaim] no callerChannelId param and no connection.currentChannelId for ${action} on task ${taskId} — using per-call anonymous identity (fail-closed)`,
    );
  }
  const result = await ctx.reviewClaimService.tryAcquire(taskId, agentId, channelId);

  if (result.acquired) {
    console.log(
      `[ReviewClaim] acquired by channel ${channelId} (agent ${agentId}) for ${action} on task ${taskId}`,
    );
    return null; // proceed
  }

  console.log(
    `[ReviewClaim] skipped ${action} on task ${taskId} for channel ${channelId}: ${result.reason}`,
  );
  return {
    skipped: true,
    reason: `review action already ${result.reason}`,
    claim: result.claim ?? null,
  };
}

/**
 * Release the review claim after the review's terminal action (the column
 * move) completes. Only the exact claiming channel can release — a late
 * release from a race loser is a no-op.
 *
 * Release uses the SAME identity resolution as acquire, but a generated
 * anonymous identity can never match a stored claim (the claim was acquired
 * under a different generated id), so an unidentified caller's release is
 * safely a no-op.
 */
export async function releaseReviewClaim(
  ctx: QueryHandlerContext,
  connection: ActiveConnection,
  taskId: string,
  agentId: string,
  params: Record<string, unknown>,
): Promise<void> {
  if (!ctx.reviewClaimService) return;
  // NOTE: release is NOT gated on shouldApplyGuard. By the time the terminal
  // move completes, the task has typically already left the review column
  // (slug is now 'done'), so a slug check here would skip the release and
  // leak the claim until TTL. The release itself is safe: it only clears the
  // slot if the caller's channelId matches the stored claim, so a stray
  // release from a non-holder is a no-op.
  const { channelId } = resolveSessionChannelId(connection, params);
  const released = await ctx.reviewClaimService.release(taskId, agentId, channelId);
  if (released) {
    console.log(`[ReviewClaim] released by channel ${channelId} on task ${taskId}`);
  }
}
