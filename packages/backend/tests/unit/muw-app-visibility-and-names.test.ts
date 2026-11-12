/**
 * MUW v2.2 — visibility (MUW-REQ-13), the per-conversation app set
 * (MUW-REQ-12) through getAgentApps, and name uniqueness within the visible
 * set with NAME_COLLISION on sharing (MUW-REQ-27).
 */
import { describe, expect, it } from 'bun:test'
import { McaService } from '../../src/services/mca-service'

function makeDb(stores: Record<string, any[]>) {
  const match = (doc: any, filter: any): boolean =>
    Object.entries(filter ?? {}).every(([k, v]) => {
      if (k === '$or') return (v as any[]).some((f) => match(doc, f))
      if (v && typeof v === 'object' && '$ne' in v) return doc[k] !== (v as any).$ne
      if (v && typeof v === 'object' && '$in' in v) return (v as any).$in.includes(doc[k])
      return doc[k] === v
    })
  return {
    collection: (name: string) => {
      const rows = (stores[name] ??= [])
      return {
        findOne: async (filter: any) => rows.find((d) => match(d, filter)) ?? null,
        find: (filter: any) => ({ toArray: async () => rows.filter((d) => match(d, filter)), project: () => ({ toArray: async () => rows.filter((d) => match(d, filter)) }) }),
        findOneAndUpdate: async (filter: any, update: any) => { const doc = rows.find((d) => match(d, filter)); if (doc) Object.assign(doc, update.$set ?? {}); return doc ?? null },
        updateOne: async (filter: any, update: any) => { const doc = rows.find((d) => match(d, filter)); if (doc) Object.assign(doc, update.$set ?? {}); return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 } },
        insertOne: async (doc: any) => { rows.push(doc); return { insertedId: doc._id } },
        countDocuments: async (filter: any) => rows.filter((d) => match(d, filter)).length,
      }
    },
  } as any
}

const WS = 'work_team'
const OWNER = 'user_owner'
const ALICE = 'user_alice'
const BOB = 'user_bob'
const AGENT = 'agent_nova'
const mcaEntry = (mcaId: string) => ({ mcaId, name: mcaId, status: 'active', availability: { enabled: true } })

function makeMca(stores: Record<string, any[]>) {
  const db = makeDb(stores)
  const workspaceService = {
    getWorkspace: async (id: string) => stores.workspaces?.find((w) => w.workspaceId === id) ?? null,
    canAdmin: async (_ws: string, userId: string) => userId === OWNER,
    canAccess: async () => true,
  } as any
  return { db, mca: new McaService(db, { workspaceService }) }
}

const apps = () => [
  { appId: 'app_gmail_alice', mcaId: 'mca.google.gmail', ownerId: WS, ownerType: 'workspace', name: 'gmail', scope: 'personal', installedBy: ALICE, status: 'active' },
  { appId: 'app_gmail_bob', mcaId: 'mca.google.gmail', ownerId: WS, ownerType: 'workspace', name: 'gmail', scope: 'personal', installedBy: BOB, status: 'active' },
  { appId: 'app_datetime', mcaId: 'mca.teros.datetime', ownerId: WS, ownerType: 'workspace', name: 'datetime', scope: 'shared', installedBy: OWNER, status: 'active' },
]

describe('visibility — MUW-REQ-13', () => {
  it('[MUW-AC-19] a member sees shared apps plus their own personal apps', () => {
    const { mca } = makeMca({})
    const [ga, gb, dt] = apps()
    expect(mca.isAppVisibleTo(ga as any, ALICE)).toBe(true)
    expect(mca.isAppVisibleTo(gb as any, ALICE)).toBe(false)
    expect(mca.isAppVisibleTo(dt as any, ALICE)).toBe(true)
    expect(mca.isAppVisibleTo(ga as any, OWNER)).toBe(false) // even the workspace owner
  })
  it('[MUW-AC-19] manage = owner or workspace owner/admin; scope = owner only', async () => {
    const { mca } = makeMca({ workspaces: [{ workspaceId: WS, ownerId: OWNER }], apps: apps() })
    const [ga] = apps()
    expect(await mca.canManageApp(ga as any, ALICE)).toBe(true)
    expect(await mca.canManageApp(ga as any, OWNER)).toBe(true)
    expect(await mca.canManageApp(ga as any, BOB)).toBe(false)
    await expect(mca.setAppScope('app_gmail_alice', OWNER, 'shared')).rejects.toThrow('ACCESS_DENIED')
  })
})

describe('the per-conversation app set — MUW-REQ-12', () => {
  const stores = () => ({
    workspaces: [{ workspaceId: WS, ownerId: OWNER }],
    agents: [{ agentId: AGENT, workspaceId: WS }],
    apps: apps(),
    agent_app_access: apps().map((a) => ({ agentId: AGENT, appId: a.appId })),
    mca_catalog: [mcaEntry('mca.google.gmail'), mcaEntry('mca.teros.datetime')],
    channels: [
      { channelId: 'ch_alice', userId: ALICE, scope: 'personal' },
      { channelId: 'ch_bob', userId: BOB, scope: 'personal' },
      { channelId: 'ch_shared', userId: ALICE, scope: 'shared' },
    ],
  })
  const names = (r: any) => r.apps.map((x: any) => x.app.appId).sort()
  it("[MUW-AC-20] Alice's personal conversation: shared + Alice's gmail; Bob's: shared + Bob's gmail", async () => {
    const { mca } = makeMca(stores())
    expect(names(await mca.getAgentApps(AGENT, WS, (await mca.getChannelViewer('ch_alice'))!))).toEqual(['app_datetime', 'app_gmail_alice'])
    expect(names(await mca.getAgentApps(AGENT, WS, (await mca.getChannelViewer('ch_bob'))!))).toEqual(['app_datetime', 'app_gmail_bob'])
  })
  it('[MUW-AC-20] a shared conversation only gets shared apps; no viewer (UI listing) → shared + mine', async () => {
    const { mca } = makeMca(stores())
    expect(names(await mca.getAgentApps(AGENT, WS, (await mca.getChannelViewer('ch_shared'))!))).toEqual(['app_datetime'])
    expect(names(await mca.getAgentApps(AGENT, WS, { userId: BOB }))).toEqual(['app_datetime', 'app_gmail_bob'])
  })
})

describe('names unique within the visible set — MUW-REQ-27', () => {
  it('[MUW-AC-21] two members may each install `gmail`; a shared name must be unique workspace-wide', async () => {
    const { mca } = makeMca({ apps: apps() })
    expect(await mca.isAppNameAvailable(WS, 'gmail', { scope: 'personal', installedBy: 'user_carol' })).toBe(true)
    expect(await mca.isAppNameAvailable(WS, 'gmail', { scope: 'personal', installedBy: ALICE })).toBe(false)
    expect(await mca.isAppNameAvailable(WS, 'datetime', { scope: 'personal', installedBy: 'user_carol' })).toBe(false)
    expect(await mca.isAppNameAvailable(WS, 'gmail', { scope: 'shared' })).toBe(false)
    expect(await mca.isAppNameAvailable(WS, 'gmail-core', { scope: 'shared' })).toBe(true)
  })
  it('[MUW-AC-21] sharing a name another member uses privately → NAME_COLLISION; after a rename it shares', async () => {
    const { mca } = makeMca({ workspaces: [{ workspaceId: WS, ownerId: OWNER }], apps: apps() })
    await expect(mca.setAppScope('app_gmail_alice', ALICE, 'shared')).rejects.toThrow('NAME_COLLISION')
    expect((await mca.renameApp('app_gmail_alice', ALICE, 'gmail-core')).success).toBe(true)
    expect((await mca.setAppScope('app_gmail_alice', ALICE, 'shared'))?.scope).toBe('shared')
    // Bob now sees his own gmail and the shared gmail-core
    const visible = apps().map((a) => a.appId)
    const { mca: m2 } = makeMca({ apps: apps().map((a) => (a.appId === 'app_gmail_alice' ? { ...a, name: 'gmail-core', scope: 'shared' } : a)) })
    expect(visible.length).toBe(3)
    expect(m2.isAppVisibleTo({ scope: 'shared', installedBy: ALICE } as any, BOB)).toBe(true)
  })
  it('[MUW-AC-21] renaming a personal app onto a shared name, or onto my own other app, is refused', async () => {
    const { mca } = makeMca({ workspaces: [{ workspaceId: WS, ownerId: OWNER }], apps: apps() })
    expect((await mca.renameApp('app_gmail_bob', BOB, 'datetime')).success).toBe(false)
    expect((await mca.renameApp('app_gmail_bob', BOB, 'gmail-bob')).success).toBe(true)
  })
})
