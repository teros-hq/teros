/**
 * BRN-AC-1 — the Browser MCA rename migration over a real Mongo.
 *   MONGODB_URI=mongodb://127.0.0.1:27017 bun test tests/unit/rename-browser-mca-migration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { type Db, MongoClient } from 'mongodb'
import migration, { applyMcaIdRenames, NEW_ID, OLD_ID } from '../../src/migrations/20261104_001_rename_browser_mca'

const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27030'
const dbName = `${process.env.MONGODB_DATABASE ?? 'teros_test_muw'}_mig_brn`

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
  for (const c of ['apps', 'agents', 'mca_catalog', 'mca_tool_health', 'tool_executions']) await db.collection(c).deleteMany({})
  await db.collection('apps').insertMany([
    { appId: 'app_b', mcaId: OLD_ID, name: 'playwright', ownerId: 'ws1' },
    { appId: 'app_t', mcaId: 'mca.teros.todo-list', name: 'tasks', ownerId: 'ws1' },
  ])
  await db.collection('agents').insertMany([
    { agentId: 'a1', enabledSystemApps: [OLD_ID, 'mca.teros.ui'], disabledSystemApps: [] },
    { agentId: 'a2', enabledSystemApps: [OLD_ID, NEW_ID], disabledSystemApps: [OLD_ID] },
    { agentId: 'a3', enabledSystemApps: ['mca.teros.ui'] },
  ])
  await db.collection('mca_catalog').insertMany([{ mcaId: OLD_ID, name: 'Browser' }, { mcaId: 'mca.teros.ui', name: 'UI' }])
  await db.collection('mca_tool_health').insertOne({ mcaId: OLD_ID, toolName: 'browser-navigate', ok: true })
  await db.collection('tool_executions').insertOne({ mcaId: OLD_ID, tool: 'browser-navigate' })
})

describe('20261104_001_rename_browser_mca (BRN-REQ-2)', () => {
  it('[BRN-AC-1] up renames the id everywhere, keeps app names and grants, drops the old catalog entry; idempotent', async () => {
    await migration.up(db)
    const app = await db.collection('apps').findOne({ appId: 'app_b' })
    expect(app).toMatchObject({ mcaId: NEW_ID, name: 'playwright', ownerId: 'ws1' })
    expect((await db.collection('apps').findOne({ appId: 'app_t' }))?.mcaId).toBe('mca.teros.todo-list')
    const a1 = await db.collection('agents').findOne({ agentId: 'a1' })
    expect(a1?.enabledSystemApps).toEqual([NEW_ID, 'mca.teros.ui'])
    const a2 = await db.collection('agents').findOne({ agentId: 'a2' })
    expect(a2?.enabledSystemApps).toEqual([NEW_ID])
    expect(a2?.disabledSystemApps).toEqual([NEW_ID])
    expect((await db.collection('agents').findOne({ agentId: 'a3' }))?.enabledSystemApps).toEqual(['mca.teros.ui'])
    expect(await db.collection('mca_catalog').countDocuments({ mcaId: OLD_ID })).toBe(0)
    expect(await db.collection('mca_catalog').countDocuments({ mcaId: 'mca.teros.ui' })).toBe(1)
    expect((await db.collection('mca_tool_health').findOne({}))?.mcaId).toBe(NEW_ID)
    expect((await db.collection('tool_executions').findOne({}))?.mcaId).toBe(NEW_ID)

    const before = JSON.stringify(await db.collection('agents').find({}, { sort: { agentId: 1 } }).toArray())
    await migration.up(db)
    expect(JSON.stringify(await db.collection('agents').find({}, { sort: { agentId: 1 } }).toArray())).toBe(before)
  })

  it('[BRN-AC-1] applyMcaIdRenames (what sync-mcas runs before deleting orphans) renames apps and toggles without touching the catalog', async () => {
    await applyMcaIdRenames(db)
    expect((await db.collection('apps').findOne({ appId: 'app_b' }))?.mcaId).toBe(NEW_ID)
    expect((await db.collection('agents').findOne({ agentId: 'a2' }))?.enabledSystemApps).toEqual([NEW_ID])
    expect(await db.collection('mca_catalog').countDocuments({ mcaId: OLD_ID })).toBe(1)
  })

  it('[BRN-AC-1] down restores the ids', async () => {
    await migration.up(db)
    await migration.down?.(db)
    expect((await db.collection('apps').findOne({ appId: 'app_b' }))?.mcaId).toBe(OLD_ID)
    expect((await db.collection('agents').findOne({ agentId: 'a1' }))?.enabledSystemApps).toEqual([OLD_ID, 'mca.teros.ui'])
    expect((await db.collection('mca_tool_health').findOne({}))?.mcaId).toBe(OLD_ID)
  })
})
