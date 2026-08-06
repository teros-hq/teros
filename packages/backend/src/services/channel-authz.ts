/**
 * SEC-2 (TER-721 / A2): authorization for channel creation.
 *
 * `channel.create`, `channel.create-with-message` and the voice transport all
 * stamp `ctx.userId` together with a client-supplied `workspaceId`/`agentId` and
 * then create a channel that drives an agent. Without these checks any
 * authenticated user could (a) create a channel inside another tenant's
 * workspace and (b) drive another tenant's private agent — which runs with that
 * agent's granted apps and secrets. That is a cross-tenant BOLA and a direct
 * prompt-injection delivery vector into a victim's agent.
 *
 * The agent predicate is intentionally identical to `agent.list`'s query
 * (see handlers/domains/agent/list.ts, which imports {@link usableAgentFilter}),
 * so the set of agents a user can start a channel with is exactly the set they
 * can see. Sharing one predicate makes the two impossible to drift apart — a
 * drift here would silently re-open the hole.
 */

import type { Db, Filter } from 'mongodb';
import { HandlerError } from '../ws-framework/WsRouter';
import type { WorkspaceService } from './workspace-service';

/**
 * Mongo filter for "agents this user may use in this workspace":
 *   - agents scoped to the workspace, OR
 *   - superagents (workspaceId null/absent) owned by the caller or the
 *     workspace owner.
 *
 * Mirrors the `$or` built inline by `agent.list`. Callers add the concrete
 * `agentId` to turn it into an existence check.
 */
export function usableAgentFilter(
  userId: string,
  workspaceId: string,
  workspaceOwnerId?: string | null,
): Filter<Record<string, unknown>> {
  const superagentOwnerIds = Array.from(
    new Set([userId, workspaceOwnerId].filter(Boolean) as string[]),
  );
  return {
    $or: [
      { workspaceId },
      { ownerId: { $in: superagentOwnerIds }, workspaceId: { $in: [null, undefined] } },
    ],
  };
}

/**
 * Throws `HandlerError('ACCESS_DENIED')` unless `userId` is a member of
 * `workspaceId` AND may use `agentId` inside it. Call before creating any
 * channel from a user-facing entry point.
 *
 * Both checks are load-bearing:
 *   - membership closes "stamp a victim's workspaceId";
 *   - the agent predicate closes "stamp your OWN workspaceId + a victim's
 *     private agentId" (membership alone passes there).
 *
 * Server-initiated callers (autoplay, board runner, g2 token route, voice
 * worker channels) pass an already-authorized userId and do NOT go through
 * this gate.
 */
export async function assertCanCreateChannel(
  db: Db,
  workspaceService: WorkspaceService | null,
  userId: string,
  workspaceId: string,
  agentId: string,
): Promise<void> {
  if (!workspaceService) {
    throw new HandlerError('WORKSPACE_NOT_CONFIGURED', 'Workspace service not available');
  }

  // 1. Caller must be a member of the target workspace.
  if (!(await workspaceService.canAccess(workspaceId, userId))) {
    throw new HandlerError('ACCESS_DENIED', 'You do not have access to this workspace');
  }

  // 2. The agent must be usable by the caller in this workspace.
  const workspace = await db
    .collection('workspaces')
    .findOne({ workspaceId } as Filter<Record<string, unknown>>);
  const workspaceOwnerId = (workspace as { ownerId?: string } | null)?.ownerId ?? null;
  const agent = await db.collection('agents').findOne({
    agentId,
    ...usableAgentFilter(userId, workspaceId, workspaceOwnerId),
  } as Filter<Record<string, unknown>>);
  if (!agent) {
    throw new HandlerError('ACCESS_DENIED', 'You do not have access to this agent');
  }
}
