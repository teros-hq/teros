/**
 * Migration: To Do node states (docs/specs/tasks/20261024_todo-improvements-plan.md §1).
 *
 * `todo_nodes` tasks gain a `state` (planning · pending · working · blocked ·
 * review · done) that replaces the `completed` boolean. Non-destructive:
 * `completed` stays (the todo actions keep writing it as `state === 'done'`)
 * and `kind` is NOT written (absent = task). Every task node without a
 * `state` gets one from `completed`: true → done, anything else → pending.
 * Groups (`kind: 'group'`) have no state and are skipped.
 *
 * Idempotent (only touches nodes without `state`). Sharding: one update per
 * workspace, each filtered by its `workspaceId` (the future shard key).
 */
import type { Db } from 'mongodb'
import type { Migration } from './types.js'

const COLLECTION = 'todo_nodes'

const migration: Migration = {
  description: 'To Do node states: set state from completed (true → done, otherwise pending) on task nodes',

  async up(db: Db): Promise<void> {
    const todoNodes = db.collection(COLLECTION)
    const workspaceIds = (await todoNodes.distinct('workspaceId', { state: { $exists: false } })) as unknown[]

    let done = 0
    let pending = 0
    for (const workspaceId of workspaceIds) {
      const base = { workspaceId, state: { $exists: false }, kind: { $ne: 'group' } }
      const toDone = await todoNodes.updateMany({ ...base, completed: true }, { $set: { state: 'done' } })
      const toPending = await todoNodes.updateMany(base, { $set: { state: 'pending' } })
      done += toDone.modifiedCount
      pending += toPending.modifiedCount
    }
    console.log(
      `[Migration 20261024_001] todo node states: ${done} done, ${pending} pending across ${workspaceIds.length} workspaces`,
    )
  },

  async down(db: Db): Promise<void> {
    // `completed` was kept in sync, so dropping `state` loses nothing the
    // pre-state code reads.
    await db.collection(COLLECTION).updateMany({ state: { $exists: true } }, { $unset: { state: '' } })
  },
}

export default migration
