/**
 * Tests for ChannelManager.searchMessages — the backend behind channel.search.
 *
 * Covers the acceptance criteria from the search-fix task:
 * - Returns real results for ≥2 char queries
 * - Finds conversations by title (metadata.name), not just message content
 * - totalMatches reflects the real total even when limit truncates results
 * - No N+1: single agents.find per search
 * - Multi-word: "portal investors" matches "investors portal"
 * - Per-channel cap prevents one hot channel from eating the global limit
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test'
import type { Db } from 'mongodb'
import { ChannelManager } from '../../../services/channel-manager'

// ─── In-memory mock store ────────────────────────────────────────────────────

interface MockChannel {
  channelId: string
  userId: string
  workspaceId: string
  agentId: string
  status: string
  scope?: 'personal' | 'shared'
  metadata: { name: string }
  createdAt: string
  updatedAt: string
}

interface MockMessage {
  messageId: string
  channelId: string
  role: 'user' | 'assistant' | 'system'
  content: { type: 'text'; text: string }
  timestamp: string
  redacted?: boolean
}

interface MockAgent {
  agentId: string
  name: string
  fullName: string
}

class Store {
  workspaces: any[] = []
  workspaceMembers: any[] = []
  channels: MockChannel[] = []
  messages: MockMessage[] = []
  agents: MockAgent[] = []
  agentsFindCalls = 0
}

function matchesRegex(value: string, condition: any): boolean {
  if (condition?.$regex) {
    const re = condition.$regex instanceof RegExp ? condition.$regex : new RegExp(condition.$regex, 'i')
    return re.test(value)
  }
  return false
}

function matchesMessageFilter(msg: MockMessage, filter: any): boolean {
  if (filter.channelId?.$in && !filter.channelId.$in.includes(msg.channelId)) return false
  if (filter['content.type'] && msg.content?.type !== filter['content.type']) return false
  if (filter.redacted?.$ne === true && msg.redacted === true) return false

  // Single-word: direct content.text condition
  if (filter['content.text']) {
    if (!matchesRegex(msg.content.text, filter['content.text'])) return false
  }

  // Multi-word: $and of per-word regexes
  if (filter.$and) {
    for (const cond of filter.$and) {
      if (cond['content.text'] && !matchesRegex(msg.content.text, cond['content.text'])) {
        return false
      }
    }
  }

  return true
}

function createMockDb(store: Store): Db {
  const workspacesFind = mock((filter: any) => ({
    toArray: () =>
      Promise.resolve(
        store.workspaces.filter(
          (w) => w.ownerId === filter.ownerId && w.status === filter.status,
        ),
      ),
  }))

  const workspaceMembersFind = mock((filter: any) => ({
    toArray: () =>
      Promise.resolve(
        store.workspaceMembers.filter(
          (m) => m.userId === filter.userId && m.status !== 'pending',
        ),
      ),
  }))

  const channelsFind = mock((filter: any) => ({
    toArray: () => {
      let chans = store.channels.filter((ch) =>
        filter.workspaceId?.$in?.includes(ch.workspaceId),
      )
      // scopeFilter: $or [ {userId, scope != shared}, {scope: shared} ]
      if (filter.$or) {
        chans = chans.filter(
          (ch) =>
            (ch.userId === filter.$or[0].userId && ch.scope !== 'shared') ||
            ch.scope === 'shared',
        )
      } else if (filter.scope === 'shared') {
        chans = chans.filter((ch) => ch.scope === 'shared')
      }
      return Promise.resolve(chans)
    },
  }))

  const messagesFind = mock((filter: any) => ({
    sort: () => ({
      limit: (n: number) => ({
        toArray: () => {
          const matched = store.messages
            .filter((m) => matchesMessageFilter(m, filter))
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, n)
          return Promise.resolve(matched)
        },
      }),
    }),
  }))

  const messagesCountDocuments = mock((filter: any) =>
    Promise.resolve(store.messages.filter((m) => matchesMessageFilter(m, filter)).length),
  )

  const agentsFind = mock((filter: any) => {
    store.agentsFindCalls++
    const ids: string[] = filter.agentId?.$in ?? []
    return {
      toArray: () => Promise.resolve(store.agents.filter((a) => ids.includes(a.agentId))),
    }
  })

  const collection = mock((name: string) => {
    if (name === 'workspaces') return { find: workspacesFind }
    if (name === 'workspace_members') return { find: workspaceMembersFind }
    if (name === 'channels') return { find: channelsFind }
    if (name === 'channel_messages')
      return { find: messagesFind, countDocuments: messagesCountDocuments }
    if (name === 'agents') return { find: agentsFind }
    return {}
  })

  return { collection } as unknown as Db
}

// ─── ChannelManager factory ──────────────────────────────────────────────────

function createManager(store: Store): ChannelManager {
  const db = createMockDb(store)
  // ChannelManager constructor takes (db, ...deps). We only need the collections
  // it touches in searchMessages: workspaces, workspace_members, channels,
  // channel_messages, agents. The rest can be undefined.
  const mgr = new ChannelManager(
    db,
    undefined as any, // sessionManager
    undefined as any, // pubsub
    undefined as any, // internalLLM
    undefined as any, // providerService
  )
  // Stub isMuwEnabled to false (single-user mode — redaction not enforced)
  ;(mgr as any).isMuwEnabled = mock(() => Promise.resolve(false))
  return mgr
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER = 'user_pablo'
const WS = 'ws_hq'
const AGENT = 'agent_nira'

function seed(store: Store) {
  store.workspaces.push({ workspaceId: WS, ownerId: USER, status: 'active' })
  store.agents.push({ agentId: AGENT, name: 'Nira', fullName: 'Nira Solana' })

  store.channels.push(
    {
      channelId: 'ch_investors',
      userId: USER,
      workspaceId: WS,
      agentId: AGENT,
      status: 'active',
      scope: 'personal',
      metadata: { name: 'Investors Portal' },
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-20T00:00:00Z',
    },
    {
      channelId: 'ch_landing',
      userId: USER,
      workspaceId: WS,
      agentId: AGENT,
      status: 'active',
      scope: 'personal',
      metadata: { name: 'Landing page' },
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-19T00:00:00Z',
    },
    {
      channelId: 'ch_random',
      userId: USER,
      workspaceId: WS,
      agentId: AGENT,
      status: 'active',
      scope: 'personal',
      metadata: { name: 'Random chat' },
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-18T00:00:00Z',
    },
  )

  // ch_investors: messages about the portal
  for (let i = 0; i < 10; i++) {
    store.messages.push({
      messageId: `msg_inv_${i}`,
      channelId: 'ch_investors',
      role: 'user',
      content: { type: 'text', text: `Update on the investors portal: iteration ${i}` },
      timestamp: `2026-10-20T10:${String(i).padStart(2, '0')}:00Z`,
    })
  }

  // ch_landing: one message mentioning investors — MOST RECENT message overall
  store.messages.push({
    messageId: 'msg_land_0',
    channelId: 'ch_landing',
    role: 'assistant',
    content: { type: 'text', text: 'The landing should mention the investors section' },
    timestamp: '2026-10-20T11:00:00Z',
  })

  // ch_random: no matches
  store.messages.push({
    messageId: 'msg_rand_0',
    channelId: 'ch_random',
    role: 'user',
    content: { type: 'text', text: 'hello world' },
    timestamp: '2026-10-18T12:00:00Z',
  })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ChannelManager.searchMessages', () => {
  let store: Store
  let manager: ChannelManager

  beforeEach(() => {
    store = new Store()
    seed(store)
    manager = createManager(store)
  })

  test('returns real results for a single-word query', async () => {
    const { results, totalMatches } = await manager.searchMessages(USER, 'portal')
    expect(results.length).toBeGreaterThan(0)
    expect(totalMatches).toBeGreaterThan(0)
    const chIds = results.map((r) => r.channelId)
    expect(chIds).toContain('ch_investors')
  })

  test('finds conversation by title (metadata.name)', async () => {
    // "Random" appears in the title of ch_random but NOT in any message text
    const { results } = await manager.searchMessages(USER, 'Random')
    const chIds = results.map((r) => r.channelId)
    expect(chIds).toContain('ch_random')
    // The title match should have a synthetic snippet = channel name
    const random = results.find((r) => r.channelId === 'ch_random')!
    expect(random.matches[0].snippet).toBe('Random chat')
  })

  test('totalMatches is the real total, not truncated by limit', async () => {
    // 10 messages in ch_investors match "portal", but limit=3
    const { totalMatches } = await manager.searchMessages(USER, 'portal', 3)
    expect(totalMatches).toBe(10)
  })

  test('no N+1: single agents.find per search', async () => {
    await manager.searchMessages(USER, 'portal')
    expect(store.agentsFindCalls).toBe(1)
  })

  test('multi-word: "portal investors" matches "investors portal"', async () => {
    const { results } = await manager.searchMessages(USER, 'portal investors')
    const chIds = results.map((r) => r.channelId)
    expect(chIds).toContain('ch_investors')
  })

  test('per-channel cap: one hot channel does not eat the whole limit', async () => {
    // ch_investors has 10 matches, ch_landing has 1. Global limit=6.
    // Without per-channel cap, ch_investors would take all 6 and ch_landing would be hidden.
    const { results } = await manager.searchMessages(USER, 'investors', 6)
    const chIds = results.map((r) => r.channelId)
    expect(chIds).toContain('ch_investors')
    expect(chIds).toContain('ch_landing')
    // Per-channel cap is 5
    const inv = results.find((r) => r.channelId === 'ch_investors')!
    expect(inv.matches.length).toBeLessThanOrEqual(5)
  })

  test('empty result when nothing matches', async () => {
    const { results, totalMatches } = await manager.searchMessages(USER, 'zzzznonexistent')
    expect(results).toEqual([])
    expect(totalMatches).toBe(0)
  })
})
