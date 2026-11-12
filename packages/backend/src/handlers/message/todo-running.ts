/**
 * The `running` flag of a To Do task (docs/specs/todo/autoplay/spec.md,
 * TODOAP-REQ-8): true exactly while an agent turn runs in the task's linked
 * conversation. Called by MessageHandler.processAgentResponse next to the
 * board's updateTaskRunning — `true` when the turn starts, `false` in its
 * finally.
 *
 * The task is looked up by its conversation (`channelId`) inside the
 * conversation's workspace. Each actual change is broadcast as
 * `todo_node_changed` to every member of the workspace. A change to false
 * does NOT run the scheduling cycle (TODOAP-REQ-18): a task the agent left
 * `working` is re-woken by the next periodic cycle, so a one-slot runner stays
 * on it. A channel linked to no task is a no-op.
 */

import type { Db } from 'mongodb';
import { COLLECTIONS, collection } from '../../db';
import type { TodoNode } from '../../mca-actions/todo';
import type { TodoAutoplayService } from '../../services/todo-autoplay-service';

/**
 * Set the running flag of the task linked to `channelId`. Returns the updated
 * task, or null when no task is linked or the flag already had that value.
 * @spec TODOAP-REQ-8, TODOAP-REQ-18
 */
export async function updateTodoNodeRunning(
  db: Db,
  autoplay: TodoAutoplayService,
  channelId: string,
  running: boolean,
): Promise<TodoNode | null> {
  const channel = await collection(db, COLLECTIONS.channels).findOne(
    { channelId },
    { projection: { _id: 0, workspaceId: 1 } },
  );
  const workspaceId = channel?.workspaceId;
  if (typeof workspaceId !== 'string' || workspaceId === '') return null;

  const updated = await collection<TodoNode>(db, COLLECTIONS.todoNodes).findOneAndUpdate(
    { workspaceId, channelId, running: running ? { $ne: true } : true },
    { $set: { running, updatedAt: Date.now() } },
    { returnDocument: 'after' },
  );
  if (!updated) return null;

  await autoplay.broadcastNodeChanged(workspaceId, updated, 'set-running');
  return updated;
}
