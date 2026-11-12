/**
 * Migration 20261102_005 — channels owned by a workspace id / 'system' /
 * 'voice-chat' are reassigned to the owner of their workspace, so the
 * MUW-REQ-4 access rule (personal channel → only its user) lets the
 * workspace owner back into their legacy conversations.
 *
 * Runs against the private test mongod (MONGODB_URI / MONGODB_DATABASE).
 *
 * @spec MUW-REQ-4, MUW-NFR-3
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MongoClient, type Db } from 'mongodb'
import migration from '../../src/migrations/20261102_005_channel_owner_is_a_user'

const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27030'
const dbName = (process.env.MONGODB_DATABASE ?? 'teros_test_muw') + '_mig005'

let client: MongoClient
let db: Db

beforeAll(async () => {
  client = new MongoClient(uri)
  await client.connect()
  db = client.db(dbName)
})
afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})
beforeEach(async () => {
  await db.collection('channels').deleteMany({})
  await db.collection('workspaces').deleteMany({})
})

const OWNER = 'user_owner'
const WS = 'ws_private'

async function seed() {
  await db.collection('workspaces').insertMany([
    { workspaceId: WS, ownerId: OWNER, status: 'active' },
    { workspaceId: 'work_team', ownerId: OWNER, status: 'active' },
    { workspaceId: 'work_noowner', status: 'active' },
  ])
  await db.collection('channels').insertMany([
    { channelId: 'ch_ws_as_user', workspaceId: WS, userId: WS },
    { channelId: 'ch_system', workspaceId: 'work_team', userId: 'system' },
    { channelId: 'ch_voice', workspaceId: WS, userId: 'voice-chat' },
    { channelId: 'ch_fine', workspaceId: WS, userId: OWNER, scope: 'personal' },
    { channelId: 'ch_member', workspaceId: 'work_team', userId: 'user_member', scope: 'personal' },
    { channelId: 'ch_sys_ws', workspaceId: 'system', userId: 'system' },
    { channelId: 'ch_orphan', workspaceId: 'work_gone', userId: 'work_gone' },
    { channelId: 'ch_no_owner', workspaceId: 'work_noowner', userId: 'system' },
  ])
}

const get = (id: string) => db.collection('channels').findOne({ channelId: id })

describe('[MUW-AC-4] migration 20261102_005: every channel is owned by a user', () => {
  it('reassigns workspace-id, "system" and "voice-chat" owners to the workspace owner and keeps the old value', async () => {
    await seed()
    await migration.up(db)
    for (const id of ['ch_ws_as_user', 'ch_system', 'ch_voice']) {
      const c = await get(id)
      expect(c?.userId).toBe(OWNER)
    }
    expect((await get('ch_ws_as_user'))?.legacyUserId).toBe(WS)
    expect((await get('ch_system'))?.legacyUserId).toBe('system')
  })

  it('leaves channels already owned by a user untouched — including other members\' personal channels', async () => {
    await seed()
    await migration.up(db)
    expect((await get('ch_fine'))?.userId).toBe(OWNER)
    expect((await get('ch_fine'))?.legacyUserId).toBeUndefined()
    expect((await get('ch_member'))?.userId).toBe('user_member')
  })

  it('leaves the system workspace and channels without a resolvable owner alone', async () => {
    await seed()
    await migration.up(db)
    expect((await get('ch_sys_ws'))?.userId).toBe('system')
    expect((await get('ch_orphan'))?.userId).toBe('work_gone')
    expect((await get('ch_no_owner'))?.userId).toBe('system')
  })

  it('is idempotent', async () => {
    await seed()
    await migration.up(db)
    const first = await db.collection('channels').find({}).sort({ channelId: 1 }).toArray()
    await migration.up(db)
    const second = await db.collection('channels').find({}).sort({ channelId: 1 }).toArray()
    expect(second).toEqual(first)
  })
})
