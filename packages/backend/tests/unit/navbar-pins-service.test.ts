/**
 * NavbarPinsService — zones, permissions, scope moves, dedupe and factory seeding.
 * Runs against the private test mongod (MONGODB_URI / MONGODB_DATABASE).
 *
 * @spec NAV-REQ-3, NAV-REQ-4, NAV-REQ-5, NAV-REQ-6, NAV-REQ-7
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MongoClient, type Db } from 'mongodb'
import { NavbarPinsService, FACTORY_PINS, pinKey } from '../../src/services/navbar-pins-service'
import type { WorkspaceService } from '../../src/services/workspace-service'

const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27030'
const dbName = (process.env.MONGODB_DATABASE ?? 'teros_test_muw') + '_navbar'

const ALICE = 'user_alice', BOB = 'user_bob'
const WS = 'work_team', WS2 = 'work_other', PRIV_A = 'ws_priv_alice', PRIV_B = 'ws_priv_bob'

let client: MongoClient
let db: Db
let service: NavbarPinsService
const events: Array<{ to: string; event: Record<string, unknown> }> = []

// Alice owns WS and WS2; Bob is a write member of WS only.
const workspaceService = {
  canAccess: async (workspaceId: string, userId: string) =>
    (userId === ALICE && [WS, WS2, PRIV_A].includes(workspaceId)) ||
    (userId === BOB && [WS, PRIV_B].includes(workspaceId)),
  canAdmin: async (workspaceId: string, userId: string) => userId === ALICE && [WS, WS2, PRIV_A].includes(workspaceId),
} as unknown as WorkspaceService
const pubSub = {
  broadcastToWorkspace: async (workspaceId: string, event: Record<string, unknown>) => { events.push({ to: `ws:${workspaceId}`, event }) },
  broadcastToUser: (userId: string, event: Record<string, unknown>) => { events.push({ to: `user:${userId}`, event }) },
} as any

beforeAll(async () => {
  client = new MongoClient(uri)
  await client.connect()
  db = client.db(dbName)
  service = new NavbarPinsService(db, workspaceService, pubSub)
})
afterAll(async () => { await db.dropDatabase(); await client.close() })
beforeEach(async () => {
  await db.collection('navbar_pins').deleteMany({})
  await db.collection('users').deleteMany({})
  await db.collection('users').insertMany([
    { userId: ALICE, privateWorkspaceId: PRIV_A },
    { userId: BOB, privateWorkspaceId: PRIV_B },
  ])
  events.length = 0
})

const fileBrowser = { type: 'file-browser', props: { initialPath: '/workspace/design' } }

describe('[NAV-AC-3] workspace zone: shared by members, edited by owner/admin', () => {
  it('a workspace pin by the owner is listed for a write member, who cannot mutate the zone', async () => {
    const { pin } = await service.pin({ workspaceId: WS, scope: 'workspace', window: fileBrowser, label: 'design' }, ALICE)
    const forBob = await service.list(WS, BOB)
    expect(forBob.map((p) => p.pinId)).toContain(pin.pinId)
    await expect(service.pin({ workspaceId: WS, scope: 'workspace', window: { type: 'todo', props: {} } }, BOB)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(service.unpin(pin.pinId, BOB)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(service.reorder(WS, 'workspace', [pin.pinId], BOB)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(service.update(pin.pinId, { label: 'x' }, BOB)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(events.some((e) => e.to === `ws:${WS}` && e.event.type === 'navbar.pins_changed')).toBe(true)
  })

  it('a personal pin of Bob is invisible to Alice and only Bob may remove it', async () => {
    const { pin } = await service.pin({ workspaceId: WS, scope: 'personal', window: fileBrowser }, BOB)
    expect((await service.list(WS, ALICE)).map((p) => p.pinId)).not.toContain(pin.pinId)
    expect((await service.list(WS, BOB)).map((p) => p.pinId)).toContain(pin.pinId)
    await expect(service.unpin(pin.pinId, ALICE)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(events.some((e) => e.to === `user:${BOB}`)).toBe(true)
  })

  it('a non-member cannot list the workspace', async () => {
    await expect(service.list(WS2, BOB)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  })
})

describe('[NAV-AC-4] personal pins: local by default, global on demand', () => {
  it('a local pin stays in its workspace; make global → everywhere; make local → back', async () => {
    const { pin } = await service.pin({ workspaceId: WS, scope: 'personal', window: fileBrowser }, ALICE)
    expect((await service.list(WS2, ALICE)).map((p) => p.pinId)).not.toContain(pin.pinId)
    const g = await service.move(pin.pinId, { global: true, workspaceId: WS }, ALICE)
    expect(g.global).toBe(true)
    expect(g.workspaceId).toBe(PRIV_A)
    expect((await service.list(WS2, ALICE)).map((p) => p.pinId)).toContain(pin.pinId)
    const l = await service.move(pin.pinId, { global: false, workspaceId: WS2 }, ALICE)
    expect(l.global).toBe(false)
    expect(l.workspaceId).toBe(WS2)
    expect((await service.list(WS, ALICE)).map((p) => p.pinId)).not.toContain(pin.pinId)
  })

  it('a workspace link is always global and cannot go to the workspace zone', async () => {
    const { pin } = await service.pin({ workspaceId: WS, scope: 'personal', window: { type: 'workspace-link', props: { workspaceId: WS2 } } }, ALICE)
    expect(pin.global).toBe(true)
    expect(pin.workspaceId).toBe(PRIV_A)
    await expect(service.move(pin.pinId, { scope: 'workspace', workspaceId: WS }, ALICE)).rejects.toMatchObject({ code: 'INVALID_WINDOW' })
  })

  it('moving a personal pin to the workspace zone needs admin and clears userId', async () => {
    const { pin } = await service.pin({ workspaceId: WS, scope: 'personal', window: fileBrowser }, BOB)
    await expect(service.move(pin.pinId, { scope: 'workspace', workspaceId: WS }, BOB)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    const { pin: mine } = await service.pin({ workspaceId: WS, scope: 'personal', window: { type: 'todo', props: { branch: 'x' } } }, ALICE)
    const moved = await service.move(mine.pinId, { scope: 'workspace', workspaceId: WS }, ALICE)
    expect(moved.scope).toBe('workspace')
    expect(moved.userId).toBeUndefined()
    expect((await service.list(WS, BOB)).map((p) => p.pinId)).toContain(mine.pinId)
  })
})

describe('[NAV-AC-5] dedupe', () => {
  it('pinning the same window twice in a zone returns the existing pin', async () => {
    const a = await service.pin({ workspaceId: WS, scope: 'personal', window: fileBrowser }, ALICE)
    const b = await service.pin({ workspaceId: WS, scope: 'personal', window: { type: 'file-browser', props: { initialPath: '/workspace/design' } } }, ALICE)
    expect(b.existed).toBe(true)
    expect(b.pin.pinId).toBe(a.pin.pinId)
    expect(await db.collection('navbar_pins').countDocuments({})).toBe(1)
  })
  it('pinKey ignores prop order and undefined values', () => {
    expect(pinKey({ type: 'x', props: { a: 1, b: 2 } })).toBe(pinKey({ type: 'x', props: { b: 2, a: 1, c: undefined } }))
  })
})

describe('[NAV-AC-2] factory pins', () => {
  it('seeds the nine factory pins in order, once', async () => {
    expect(await service.seedFactoryPins(WS, ALICE)).toBe(FACTORY_PINS.length)
    expect(await service.seedFactoryPins(WS, ALICE)).toBe(0)
    const pins = (await service.list(WS, BOB)).filter((p) => p.factory)
    expect(pins.map((p) => p.window.type)).toEqual(FACTORY_PINS.map((f) => f.type))
    expect(pins.every((p) => p.labelKey && p.icon && p.window.props.workspaceId === WS)).toBe(true)
  })
  it('the owner can remove a factory pin and reorder the zone', async () => {
    await service.seedFactoryPins(WS, ALICE)
    const pins = await service.list(WS, ALICE)
    const academy = pins.find((p) => p.window.type === 'academy')!
    await service.unpin(academy.pinId, ALICE)
    const rest = (await service.list(WS, ALICE)).map((p) => p.pinId)
    await service.reorder(WS, 'workspace', [rest[rest.length - 1], rest[0]], ALICE)
    const after = (await service.list(WS, ALICE)).map((p) => p.pinId)
    expect(after[0]).toBe(rest[rest.length - 1])
    expect(after[1]).toBe(rest[0])
    expect(after.length).toBe(FACTORY_PINS.length - 1)
  })
})
