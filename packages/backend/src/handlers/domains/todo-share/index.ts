/**
 * todo-share — public links to a To Do task's output or input
 * (docs/specs/todo/output-window.md, TODOOV-REQ-4).
 *
 * The three To Do actions `share-io`, `get-io-share` and `unshare-io`
 * (mca-actions/todo.ts resolves the workspace and the caller, then delegates
 * here) and the request-time resolution `GET /share/:shareId` uses for a
 * `todo-io` share (handlers/http-share-handler.ts).
 *
 * A share record lives in `shared_files` (ShareService) with
 * `source: { kind: 'todo-io', workspaceId, nodeId, io }` and points at the
 * node, never at a snapshot: serving it reads the task's CURRENT io. Every
 * read is scoped to the share's workspace (workspace sovereignty).
 */

import type { Db } from 'mongodb';
import { McaActionError } from '../../../mca-actions/errors';
import {
  ShareService,
  sharePublicUrl,
  type CreateShareResult,
  type TodoIoShare,
} from '../../../services/share-service';

/** Which io of a task a share points at. */
export type TodoIoSlot = 'output' | 'input';

/** The io shapes this module reads (the subset of a stored NodeIO it needs). */
type StoredIO =
  | { format: 'markdown'; markdown: string }
  | { format: 'form' }
  | { format: 'file'; url: string; name: string; mime: string };

interface IoNode {
  nodeId: string;
  text: string;
  output?: StoredIO | null;
  input?: StoredIO | null;
}

/** What `GET /share/:shareId` serves for a todo-io share. */
export type TodoIoShareContent =
  | { kind: 'markdown'; title: string; markdown: string }
  | { kind: 'file'; url: string };

const TODO_NODES = 'todo_nodes';

function fail(code: string, message: string, status = 400, suggestion?: string): never {
  throw new McaActionError(code, message, status, suggestion);
}

/** One workspace-scoped read of the node, projected to its text and the io slot. */
function readNode(db: Db, workspaceId: string, nodeId: string, io: TodoIoSlot): Promise<IoNode | null> {
  return db
    .collection<IoNode>(TODO_NODES)
    .findOne({ workspaceId, nodeId } as any, { projection: { _id: 0, nodeId: 1, text: 1, [io]: 1 } }) as Promise<IoNode | null>;
}

/**
 * share-io: the caller's share of a task's markdown or file io — the existing
 * one, else a new one. A missing node is NOT_FOUND; a form or missing io is
 * INVALID_STATE (409).
 * @spec TODOOV-REQ-4
 */
export async function shareIo(
  db: Db,
  workspaceId: string,
  userId: string,
  input: { nodeId: string; io: TodoIoSlot },
): Promise<CreateShareResult> {
  const node = await readNode(db, workspaceId, input.nodeId, input.io);
  if (!node) return fail('NOT_FOUND', `Node "${input.nodeId}" not found.`, 404);
  const io = node[input.io];
  if (!io || (io.format !== 'markdown' && io.format !== 'file')) {
    return fail(
      'INVALID_STATE',
      io ? `The ${input.io} of task "${input.nodeId}" is a form and cannot be shared.` : `Task "${input.nodeId}" has no ${input.io}.`,
      409,
      'Only a markdown or file io can be shared.',
    );
  }
  const shares = new ShareService(db);
  const existing = await shares.getIoShare(userId, workspaceId, input.nodeId, input.io);
  if (existing) return { shareId: existing.shareId, publicUrl: sharePublicUrl(existing.shareId) };
  return shares.createIoShare(userId, { kind: 'todo-io', workspaceId, nodeId: input.nodeId, io: input.io });
}

/**
 * get-io-share: the caller's share of a task's io, or null. A missing node
 * is NOT_FOUND.
 * @spec TODOOV-REQ-4
 */
export async function getIoShare(
  db: Db,
  workspaceId: string,
  userId: string,
  input: { nodeId: string; io: TodoIoSlot },
): Promise<CreateShareResult | null> {
  const node = await readNode(db, workspaceId, input.nodeId, input.io);
  if (!node) return fail('NOT_FOUND', `Node "${input.nodeId}" not found.`, 404);
  const share = await new ShareService(db).getIoShare(userId, workspaceId, input.nodeId, input.io);
  return share ? { shareId: share.shareId, publicUrl: sharePublicUrl(share.shareId) } : null;
}

/**
 * unshare-io: revoke a todo-io share of this workspace. A share that does not
 * exist, is not a todo-io share or belongs to another workspace is NOT_FOUND;
 * a share of another user is FORBIDDEN (only the owner revokes).
 * @spec TODOOV-REQ-4
 */
export async function unshareIo(
  db: Db,
  workspaceId: string,
  userId: string,
  input: { shareId: string },
): Promise<{ ok: true }> {
  const shares = new ShareService(db);
  const share = await shares.getShare(input.shareId);
  if (!share || share.source?.kind !== 'todo-io' || share.source.workspaceId !== workspaceId) {
    return fail('NOT_FOUND', `Share "${input.shareId}" not found.`, 404);
  }
  if (share.ownerId !== userId) {
    return fail('FORBIDDEN', 'Only the user who created a share can revoke it.', 403);
  }
  await shares.deleteShare(input.shareId, userId);
  return { ok: true };
}

/**
 * What a todo-io share serves now: the task's current markdown (titled with
 * the task text) or its file's object URL. null when the node or the io is
 * gone, or the io is a form (the caller answers 404). One node read, scoped to
 * the share's workspace.
 * @spec TODOOV-REQ-4
 * @spec TODOOV-NFR-1
 */
export async function resolveIoShareContent(db: Db, share: TodoIoShare): Promise<TodoIoShareContent | null> {
  const { workspaceId, nodeId, io } = share.source;
  const node = await readNode(db, workspaceId, nodeId, io);
  const value = node?.[io];
  if (!node || !value) return null;
  if (value.format === 'markdown') return { kind: 'markdown', title: node.text, markdown: value.markdown };
  if (value.format === 'file') return { kind: 'file', url: value.url };
  return null;
}
