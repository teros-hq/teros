/**
 * artifact.list / artifact.get — the workspace artifact catalog
 * (docs/specs/tasks/artifacts.md): global types are visible everywhere,
 * workspace types only to their workspace, and the event type registry
 * derives form-first schemas from the manifest payload declarations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { WsHandlerContext } from '@teros/shared'
import { type Db, MongoClient } from 'mongodb'
import { createArtifactListHandler } from '../../src/handlers/domains/artifact/list'
import { createArtifactGetHandler } from '../../src/handlers/domains/artifact/get'
import { eventArtifactId, payloadFieldToProperty, resolveEventArtifact, syncEventArtifactTypes } from '../../src/services/event-artifact-types'

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017'
const DB_NAME = `teros_test_artifacts_${Date.now()}`
let client: MongoClient
let db: Db

const WS_A = 'work_aaaaaaaaaaaaaaaa'
const WS_B = 'work_bbbbbbbbbbbbbbbb'
const workspaceService = { canAccess: async (workspaceId: string, userId: string) => userId === `member_of_${workspaceId}` } as any
const ctx = (userId: string) => ({ userId } as unknown as WsHandlerContext)

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db(DB_NAME)
  await db.collection('artifacts').insertMany([
    { artifactId: 'art_global_lead', source: 'global', name: 'Lead', title: 'Lead', schema: { name: 'Lead', title: 'Lead', type: 'object', properties: { email: { name: 'email', type: 'text' } } } },
    { artifactId: 'art_ws_a_report', source: 'workspace', workspaceId: WS_A, name: 'Report', title: 'Report', schema: { name: 'Report', title: 'Report', type: 'object', properties: { body: { name: 'body', type: 'textarea' } } } },
    { artifactId: 'art_ws_b_secret', source: 'workspace', workspaceId: WS_B, name: 'Secret', title: 'Secret', schema: { name: 'Secret', title: 'Secret', type: 'object', properties: {} } },
  ])
  await db.collection('mca_catalog').insertOne({
    mcaId: 'mca.demo',
    events: [
      { topic: 'demo.thing.happened', description: 'Something happened', payload: { id: 'string', count: 'number', when: 'ISO date', kind: 'a|b|c', note: 'string|null', tags: 'string[]', ok: 'boolean' } },
    ],
  })
})

afterAll(async () => {
  await db.dropDatabase()
  await client.close()
})

describe('artifact.list / artifact.get', () => {
  it('lists global + own workspace types with their field names, never another workspace', async () => {
    const list = createArtifactListHandler(db, workspaceService)
    const res = (await list(ctx(`member_of_${WS_A}`), { workspaceId: WS_A })) as { artifacts: Array<{ artifactId: string; fields: string[] }> }
    expect(res.artifacts.map((a) => a.artifactId).sort()).toEqual(['art_global_lead', 'art_ws_a_report'])
    expect(res.artifacts.find((a) => a.artifactId === 'art_ws_a_report')!.fields).toEqual(['body'])
    await expect(list(ctx('stranger'), { workspaceId: WS_A })).rejects.toThrow('Access denied')
  })

  it('get: global readable by anyone, workspace types only by members', async () => {
    const get = createArtifactGetHandler(db, workspaceService)
    const g = (await get(ctx('anyone'), { artifactId: 'art_global_lead' })) as { artifact: { schema: { properties: Record<string, unknown> } } }
    expect(Object.keys(g.artifact.schema.properties)).toEqual(['email'])
    await expect(get(ctx('anyone'), { artifactId: 'art_ws_b_secret' })).rejects.toThrow('Access denied')
    await expect(get(ctx('anyone'), { artifactId: 'art_nope' })).rejects.toThrow('not found')
  })
})

describe('event artifact types', () => {
  it('derives a form-first schema from the manifest payload declaration', () => {
    expect(payloadFieldToProperty('count', 'number')).toMatchObject({ type: 'number', required: true })
    expect(payloadFieldToProperty('ok', 'boolean')).toMatchObject({ type: 'checkbox' })
    expect(payloadFieldToProperty('when', 'ISO date')).toMatchObject({ type: 'datetime' })
    expect(payloadFieldToProperty('kind', 'a|b|c')).toMatchObject({ type: 'select', options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }, { value: 'c', label: 'c' }] })
    expect(payloadFieldToProperty('note', 'string|null')).toMatchObject({ type: 'text', required: false })
    expect(payloadFieldToProperty('tags', 'string[]')).toMatchObject({ type: 'textarea' })
    expect(eventArtifactId('telegram.message.received')).toBe('art_evt_telegram_message_received')
  })

  it('sync registers one global type per declared topic; resolve finds or builds it', async () => {
    expect(await syncEventArtifactTypes(db)).toBe(1)
    const stored = await db.collection('artifacts').findOne({ artifactId: 'art_evt_demo_thing_happened' })
    expect(stored).toMatchObject({ source: 'global', name: 'demo.thing.happened' })
    expect(Object.keys((stored as any).schema.properties)).toEqual(['id', 'count', 'when', 'kind', 'note', 'tags', 'ok'])

    const resolved = await resolveEventArtifact(db, 'demo.thing.happened')
    expect(resolved?.schemaId).toBe('art_evt_demo_thing_happened')
    expect(await resolveEventArtifact(db, 'nobody.declares.this')).toBeNull()

    // Visible in the catalog of any workspace
    const list = createArtifactListHandler(db, workspaceService)
    const res = (await list(ctx(`member_of_${WS_B}`), { workspaceId: WS_B, source: 'global' })) as { artifacts: Array<{ artifactId: string }> }
    expect(res.artifacts.map((a) => a.artifactId)).toContain('art_evt_demo_thing_happened')
  })
})
