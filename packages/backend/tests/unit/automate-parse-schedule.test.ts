/**
 * automate.parse-schedule — the read-only NL/cron preview powering the
 * Automate window form (v1.4.4). Real router + workspace access check.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MongoClient, type Db } from 'mongodb'
import { WsRouter } from '../../src/ws-framework/WsRouter'
import { register } from '../../src/handlers/domains/automate'
import { WorkspaceService } from '../../src/services/workspace-service'
import type { WsHandlerContext } from '@teros/shared'

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017'
let client: MongoClient
let db: Db
let handlers: Map<string, any>
let currentWs = ''
let call = 0

const CTX = (userId = 'user_niraparse0001'): WsHandlerContext =>
  ({ userId, sessionId: 'sess_parse1', userAgent: 'test' }) as unknown as WsHandlerContext

beforeAll(async () => {
  client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 3000 })
  await client.connect()
  db = client.db('teros_test_parse_schedule')
  const router = new WsRouter()
  const ws = new WorkspaceService(db)
  register(router, { db, workspaceService: ws, runner: null })
  // biome-ignore lint/suspicious/noExplicitAny: acceso al Map privado — patrón del repo
  handlers = (router as any).handlers
})

beforeEach(async () => {
  await db.collection('workspaces').deleteMany({})
  await db.collection('workspace_members').deleteMany({})
  call += 1
  const wsId = `work_parse${call}`
  currentWs = wsId
  await db.collection('workspaces').insertOne({ workspaceId: wsId, name: 'W', ownerId: CTX().userId, status: 'active' })
  await db.collection('workspace_members').insertOne({ workspaceId: wsId, userId: CTX().userId, role: 'owner' })
})

afterAll(async () => {
  await db.dropDatabase().catch(() => {})
  await client.close()
})

const handler = () => {
  const h = handlers.get('automate.parse-schedule')
  if (!h) throw new Error('automate.parse-schedule not registered')
  return h
}
const req = (data: Record<string, unknown>) => handler()(CTX(), data)

describe('automate.parse-schedule', () => {
  it('translates NL → cron + human preview + next runs in the timezone', async () => {
    const out = (await req({
      workspaceId: currentWs,
      expression: 'cada lunes a las 9',
      timezone: 'Europe/Madrid',
      locale: 'es',
    })) as Record<string, any>
    expect(out.ok).toBe(true)
    expect(out.cron).toBe('0 9 * * 1')
    expect(out.scheduleHuman).toBe('Se ejecutará: lunes a las 09:00')
    expect(out.next.length).toBe(3)
    for (const iso of out.next) expect(Date.parse(iso)).toBeGreaterThan(Date.now())
    // 09:00 Madrid in late October = 08:00 UTC (CET from Oct 25)
    expect(out.next[0]).toContain('T08:00:00.000Z')
  })

  it('passes a raw cron through and describes it', async () => {
    const out = (await req({
      workspaceId: currentWs,
      expression: '0 9 * * 1-5',
    })) as Record<string, any>
    expect(out.ok).toBe(true)
    expect(out.cron).toBe('0 9 * * 1-5')
    expect(out.scheduleHuman).toBe('Runs: weekdays (Monday to Friday) at 09:00')
    expect(out.timezone).toBe('UTC')
  })

  it('returns ok:false with a suggestion for untranslatable input (no throw)', async () => {
    const out = (await req({
      workspaceId: currentWs,
      expression: 'when I feel like it',
    })) as Record<string, any>
    expect(out.ok).toBe(false)
    expect(out.suggestion).toContain('cada lunes a las 9')
  })

  it('rejects a foreign workspace and a bad timezone', async () => {
    const codes = async (promise: Promise<unknown>): Promise<string> => {
      try {
        await promise
        return 'NO_THROW'
      } catch (e) {
        return (e as { code?: string }).code ?? 'NO_CODE'
      }
    }
    expect(await codes(req({ workspaceId: 'work_other', expression: 'cada lunes a las 9' }))).toBe('FORBIDDEN')
    expect(
      await codes(req({ workspaceId: currentWs, expression: 'cada lunes a las 9', timezone: 'Mars/Olympus' })),
    ).toBe('INVALID_TIMEZONE')
  })
})
