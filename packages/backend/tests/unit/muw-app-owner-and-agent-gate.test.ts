/**
 * MUW v2.1 — app ownership (MUW-REQ-10/11), the critical rule on the agent
 * path (MUW-REQ-12b) and team-owned agents (MUW-REQ-3).
 */
import { describe, expect, it } from 'bun:test'
import { McaService } from '../../src/services/mca-service'
import { createUpdateAgentHandler } from '../../src/handlers/domains/agent/update'
import { createDeleteAgentHandler } from '../../src/handlers/domains/agent/delete'

function makeDb(stores: Record<string, any[]>) {
  const match = (doc: any, filter: any) =>
    Object.entries(filter ?? {}).every(([k, v]) => {
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
        findOneAndUpdate: async (filter: any, update: any) => {
          const doc = rows.find((d) => match(d, filter))
          if (doc) Object.assign(doc, update.$set ?? {})
          return doc ?? null
        },
        updateOne: async (filter: any, update: any) => {
          const doc = rows.find((d) => match(d, filter))
          if (doc) Object.assign(doc, update.$set ?? {})
          return { matchedCount: doc ? 1 : 0, modifiedCount: doc ? 1 : 0 }
        },
        countDocuments: async (filter: any) => rows.filter((d) => match(d, filter)).length,
      }
    },
  } as any
}

const WS = 'work_team'
const OWNER = 'user_owner'
const ALICE = 'user_alice'
const BOB = 'user_bob'

function makeMca(stores: Record<string, any[]>) {
  const db = makeDb(stores)
  const workspaceService = { getWorkspace: async (id: string) => stores.workspaces?.find((w) => w.workspaceId === id) ?? null } as any
  return { db, mca: new McaService(db, { workspaceService }) }
}

describe('app ownership — MUW-REQ-10 / MUW-REQ-11', () => {
  it('[MUW-AC-22] an app with no scope is never usable (data integrity, no default)', () => {
    const { mca } = makeMca({})
    const viewer = { userId: ALICE, channelScope: 'personal' as const }
    expect(mca.isAppUsableBy({ appId: 'a', installedBy: ALICE } as any, viewer)).toBe(false)
    expect(mca.isAppUsableBy({ appId: 'a', installedBy: ALICE, scope: 'personal' } as any, viewer)).toBe(true)
  })

  it('[MUW-AC-5] only the installer may change the scope — a write member is denied', async () => {
    const stores = {
      workspaces: [{ workspaceId: WS, ownerId: OWNER, status: 'active' }],
      apps: [{ appId: 'app_1', ownerId: WS, ownerType: 'workspace', installedBy: ALICE, scope: 'personal' }],
      workspace_members: [{ workspaceId: WS, userId: BOB, role: 'write', status: 'active' }],
    }
    const { mca } = makeMca(stores)
    await expect(mca.setAppScope('app_1', BOB, 'shared')).rejects.toThrow('ACCESS_DENIED')
    await expect(mca.setAppScope('app_1', OWNER, 'shared')).rejects.toThrow('ACCESS_DENIED')
    const updated = await mca.setAppScope('app_1', ALICE, 'shared')
    expect(updated?.scope).toBe('shared')
  })

  it('[MUW-AC-22] an app without installedBy has no owner — nobody may change its scope (migrations, not fallbacks)', async () => {
    const stores = {
      workspaces: [{ workspaceId: WS, ownerId: OWNER, status: 'active' }],
      apps: [{ appId: 'app_legacy', ownerId: WS, ownerType: 'workspace', scope: 'personal' }],
      workspace_members: [{ workspaceId: WS, userId: ALICE, role: 'admin', status: 'active' }],
    }
    const { mca } = makeMca(stores)
    await expect(mca.setAppScope('app_legacy', ALICE, 'shared')).rejects.toThrow('ACCESS_DENIED')
    await expect(mca.setAppScope('app_legacy', OWNER, 'shared')).rejects.toThrow('ACCESS_DENIED')
  })

  it('unknown app → null (not found, not denied)', async () => {
    const { mca } = makeMca({ apps: [] })
    expect(await mca.setAppScope('nope', ALICE, 'shared')).toBeNull()
  })
})

describe('the critical rule on the agent path — MUW-REQ-12b', () => {
  const channels = [
    { channelId: 'ch_shared', userId: ALICE, scope: 'shared' },
    { channelId: 'ch_personal', userId: ALICE, scope: 'personal' },
    { channelId: 'ch_legacy', userId: ALICE },
  ]
  it('[MUW-AC-2] a personal app is blocked in a shared conversation, whoever owns it', async () => {
    const { mca } = makeMca({ channels })
    expect(await mca.isAppBlockedInChannel({ appId: 'a', scope: 'personal', installedBy: ALICE } as any, 'ch_shared')).toBe(true)
    expect(await mca.isAppBlockedInChannel({ appId: 'a', installedBy: ALICE } as any, 'ch_shared')).toBe(true) // no scope → never runs
  })
  it('[MUW-AC-20] in a personal conversation a personal app runs only for its owner; shared apps always', async () => {
    const { mca } = makeMca({ channels })
    expect(await mca.isAppBlockedInChannel({ appId: 'a', scope: 'shared', installedBy: ALICE } as any, 'ch_shared')).toBe(false)
    expect(await mca.isAppBlockedInChannel({ appId: 'a', scope: 'personal', installedBy: ALICE } as any, 'ch_personal')).toBe(false)
    expect(await mca.isAppBlockedInChannel({ appId: 'a', scope: 'personal', installedBy: BOB } as any, 'ch_personal')).toBe(true)
    expect(await mca.isAppBlockedInChannel({ appId: 'a', scope: 'personal', installedBy: ALICE } as any, 'ch_legacy')).toBe(false)
    expect(await mca.isAppBlockedInChannel({ appId: 'a', scope: 'personal', installedBy: ALICE } as any, 'ch_missing')).toBe(true)
  })
})

describe('team-owned agents — MUW-REQ-3', () => {
  const agents = () => [
    { agentId: 'agent_nova', ownerId: ALICE, workspaceId: WS, name: 'Nova', status: 'active' },
    { agentId: 'agent_super', ownerId: ALICE, workspaceId: null, name: 'Iria', status: 'active' },
  ]
  const base = () => ({
    agents: agents(),
    agent_cores: [],
    workspaces: [{ workspaceId: WS, ownerId: OWNER, status: 'active' }],
    workspace_members: [
      { workspaceId: WS, userId: ALICE, role: 'write', status: 'active' },
      { workspaceId: WS, userId: BOB, role: 'write', status: 'active' },
      { workspaceId: WS, userId: 'user_pending', role: 'write', status: 'pending' },
    ],
  })
  const ctx = (userId: string) => ({ userId, sessionId: 's1' }) as any

  it('[MUW-AC-6] another active member updates a workspace agent', async () => {
    const stores = base()
    const handler = createUpdateAgentHandler(makeDb(stores), null)
    const r = await handler(ctx(BOB), { agentId: 'agent_nova', intro: 'edited by Bob' })
    expect(r.agent.intro).toBe('edited by Bob')
  })

  it('a pending member or an outsider gets ACCESS_DENIED; an unknown agent AGENT_NOT_FOUND', async () => {
    const handler = createUpdateAgentHandler(makeDb(base()), null)
    await expect(handler(ctx('user_pending'), { agentId: 'agent_nova', intro: 'x' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(handler(ctx('user_outsider'), { agentId: 'agent_nova', intro: 'x' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(handler(ctx(BOB), { agentId: 'agent_missing', intro: 'x' })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
  })

  it('a global agent (superagent) stays private to its owner', async () => {
    const handler = createUpdateAgentHandler(makeDb(base()), null)
    await expect(handler(ctx(BOB), { agentId: 'agent_super', intro: 'x' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect((await handler(ctx(ALICE), { agentId: 'agent_super', intro: 'mine' })).agent.intro).toBe('mine')
  })

  it('[MUW-AC-6] delete: membership is checked before the cascade', async () => {
    const stores = base()
    const handler = createDeleteAgentHandler(makeDb(stores), null)
    await expect(handler(ctx('user_outsider'), { agentId: 'agent_nova' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(handler(ctx(BOB), { agentId: 'agent_missing' })).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' })
  })
})
