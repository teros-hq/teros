/**
 * Unit — 20261024_001_todo_node_states (docs/specs/tasks/20261024_todo-improvements-plan.md §1).
 *
 * Pins: completed:true → done, anything else → pending, per workspace; groups
 * and nodes that already have a state are untouched; `completed` and `kind`
 * are not rewritten; re-running is a no-op; down() drops `state` only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { type Db, MongoClient } from 'mongodb'
import migration from '../../src/migrations/20261024_001_todo_node_states'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = `teros_todo_states_mig_test_${Date.now()}`

let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db(DB_NAME)
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

beforeEach(async () => {
  await db.collection('todo_nodes').deleteMany({})
  await db.collection('todo_nodes').insertMany([
    { nodeId: 'a', workspaceId: 'ws_1', parentId: null, completed: true },
    { nodeId: 'b', workspaceId: 'ws_1', parentId: null, completed: false },
    { nodeId: 'c', workspaceId: 'ws_2', parentId: null, completed: true },
    { nodeId: 'd', workspaceId: 'ws_2', parentId: null }, // no completed at all
    { nodeId: 'g', workspaceId: 'ws_2', parentId: null, completed: false, kind: 'group' },
    { nodeId: 'w', workspaceId: 'ws_2', parentId: null, completed: false, state: 'working' },
  ])
})

async function byId(nodeId: string) {
  return db.collection('todo_nodes').findOne({ nodeId }, { projection: { _id: 0 } })
}

describe('20261024_001_todo_node_states', () => {
  it('sets state from completed on task nodes of every workspace', async () => {
    await migration.up(db)
    expect((await byId('a'))?.state).toBe('done')
    expect((await byId('b'))?.state).toBe('pending')
    expect((await byId('c'))?.state).toBe('done')
    expect((await byId('d'))?.state).toBe('pending')
  })

  it('leaves groups, existing states, completed and kind untouched', async () => {
    await migration.up(db)
    expect(await byId('g')).toEqual({ nodeId: 'g', workspaceId: 'ws_2', parentId: null, completed: false, kind: 'group' })
    expect((await byId('w'))?.state).toBe('working')
    expect((await byId('a'))?.completed).toBe(true)
    expect((await byId('a'))?.kind).toBeUndefined()
  })

  it('is idempotent', async () => {
    await migration.up(db)
    await db.collection('todo_nodes').updateOne({ nodeId: 'a' }, { $set: { state: 'review' } })
    await migration.up(db)
    expect((await byId('a'))?.state).toBe('review')
    expect((await byId('b'))?.state).toBe('pending')
  })

  it('down() removes state only', async () => {
    await migration.up(db)
    await migration.down!(db)
    expect(await byId('a')).toEqual({ nodeId: 'a', workspaceId: 'ws_1', parentId: null, completed: true })
    expect(await byId('w')).toEqual({ nodeId: 'w', workspaceId: 'ws_2', parentId: null, completed: false })
  })
})
