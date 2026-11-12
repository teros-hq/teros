/**
 * todo log — the one place a task's log entry is built (TODOLG).
 *
 * Every log entry carries its actor: the person, the agent or the system that
 * did what the line says. Every writer goes through here — `pushLogEntry`,
 * `writeNode`'s `log` and `writeStateTransition`'s log (todo.ts), and the
 * autoplay service's own entries — so no entry is written without one.
 *
 * Part of the todo capability (todo.ts): `todo_nodes` stays private to it.
 */

import type { Db } from 'mongodb';
import type { McaActionCtx } from './index';
import type { TodoNode } from './todo';

const COLLECTION = 'todo_nodes';

/**
 * Who wrote a log entry. `id` is the userId (user) or agentId (agent); the
 * system has none.
 * @spec TODOLG-REQ-1
 */
export interface LogActor {
  kind: 'user' | 'agent' | 'system';
  id?: string;
}

/**
 * A single entry of a node's chronological log. Entries written before
 * TODOLG have no `actor` (unknown).
 * @spec TODOLG-REQ-1
 */
export interface LogEntry {
  timestamp: number;
  text: string;
  actor?: LogActor;
}

/**
 * A log entry to write: its text and who wrote it.
 * @spec TODOLG-REQ-1
 */
export interface LogWrite {
  text: string;
  actor: LogActor;
}

/**
 * The scheduler acting on its own.
 * @spec TODOLG-REQ-1
 */
export const SYSTEM_ACTOR: LogActor = { kind: 'system' };

/**
 * Build the stored entry for `write` at `timestamp`.
 * @spec TODOLG-REQ-1
 */
export function logEntry(write: LogWrite, timestamp: number = Date.now()): LogEntry {
  return { timestamp, text: write.text, actor: { ...write.actor } };
}

/**
 * Who an action acts as, in this order:
 *   - `callerAgentId` in the body (the thin client fills it from the
 *     execution context's `agentId`, present exactly when an agent is the one
 *     calling) whose agent belongs to the task's workspace → that agent,
 *     whatever `callerUserId` says (there it is the billing user, not the
 *     actor); an unknown agent is ignored;
 *   - else `callerUserId` in the body → that user;
 *   - else the system.
 * The callback URL's segment (`ctx.channelId`) is the app id, not a
 * conversation, so the actor is never derived from it.
 * @spec TODOLG-REQ-1
 */
export async function resolveActor(
  db: Db,
  wsId: string,
  _ctx: McaActionCtx,
  body: Record<string, unknown>,
): Promise<LogActor> {
  const callerAgentId = body?.callerAgentId;
  if (typeof callerAgentId === 'string' && callerAgentId !== '' && (await isWorkspaceAgent(db, wsId, callerAgentId))) {
    return { kind: 'agent', id: callerAgentId };
  }
  const callerUserId = body?.callerUserId;
  if (typeof callerUserId === 'string' && callerUserId !== '') return { kind: 'user', id: callerUserId };
  return { kind: 'system' };
}

/**
 * The agent exists in `wsId`: an agent of the workspace, or a superagent (no
 * workspace) whose owner is the owner / an active member of it — the same
 * rule as an assignee (todo.ts resolveAssignee).
 */
async function isWorkspaceAgent(db: Db, wsId: string, agentId: string): Promise<boolean> {
  const agent = await db.collection('agents').findOne({ agentId }, { projection: { workspaceId: 1, ownerId: 1 } });
  if (!agent) return false;
  if (typeof agent.workspaceId === 'string' && agent.workspaceId !== '') return agent.workspaceId === wsId;
  const ownerId = agent.ownerId;
  if (typeof ownerId !== 'string' || ownerId === '') return false;
  const ws = await db.collection('workspaces').findOne({ workspaceId: wsId }, { projection: { ownerId: 1 } });
  if (ws?.ownerId === ownerId) return true;
  const m = await db
    .collection('workspace_members')
    .findOne({ workspaceId: wsId, userId: ownerId, status: { $ne: 'pending' } }, { projection: { _id: 1 } });
  return Boolean(m);
}

/**
 * Append a log entry written by `actor` and bump updatedAt; returns the
 * post-write node. Scope: { workspaceId, nodeId }.
 * @spec TODOLG-REQ-1
 */
export async function pushLogEntry(
  db: Db,
  wsId: string,
  nodeId: string,
  text: string,
  actor: LogActor,
): Promise<TodoNode | null> {
  const now = Date.now();
  const result = await db.collection<TodoNode>(COLLECTION).findOneAndUpdate(
    { workspaceId: wsId, nodeId },
    {
      $push: { log: logEntry({ text, actor }, now) },
      $set: { updatedAt: now },
    },
    { returnDocument: 'after' },
  );
  return result || null;
}
