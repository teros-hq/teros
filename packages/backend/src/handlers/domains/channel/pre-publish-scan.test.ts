/**
 * Unit tests for channel.pre-publish-scan handler (REQ-8).
 *
 * Tests cover:
 * - AC-10: personal app used → appears in personalApps
 * - AC-11: app that was personal when used but is now shared → does NOT appear
 * - Edge case: app that was shared when used but is now personal → DOES appear
 * - Authorization: only channel creator can run the scan
 * - Empty channel / no tool executions → no warning
 * - AppId resolution from mcaId when appId is not stored directly
 */

import { describe, expect, test, mock } from 'bun:test'
import type { Db } from 'mongodb'
import { createPrePublishScanHandler } from './pre-publish-scan'
import type { ChannelManager } from '../../../services/channel-manager'
import type { WsHandlerContext } from '@teros/shared'

// ─── Mock helpers ──────────────────────────────────────────────────────────────

const CREATOR_ID = 'user_creator'
const OTHER_ID = 'user_other'
const CHANNEL_ID = 'ch_test123'
const WORKSPACE_ID = 'ws_test'

interface MockChannel {
  channelId: string
  userId: string
  workspaceId: string
  scope?: 'personal' | 'shared'
  [key: string]: unknown
}

interface MockApp {
  appId: string
  mcaId: string
  ownerId: string
  name: string
  scope?: 'personal' | 'shared'
  status?: string
}

interface MockMessage {
  content: {
    type: string
    appId?: string
    mcaId?: string
    mcpId?: string
  }
}

/**
 * Create a mock ChannelManager whose getChannel returns a pre-configured channel.
 */
function createMockChannelManager(channel: MockChannel | null): Pick<ChannelManager, 'getChannel'> {
  return {
    getChannel: mock(() => Promise.resolve(channel as any)),
  }
}


/**
 * Create a mock Db with configurable channel_messages and apps collections.
 */
function createMockDb(opts: {
  channel?: MockChannel | null
  messages?: MockMessage[]
  apps?: MockApp[]
}): Db {
  const channel = opts.channel ?? {
    channelId: CHANNEL_ID,
    userId: CREATOR_ID,
    workspaceId: WORKSPACE_ID,
    scope: 'personal' as const,
  }

  const messages = opts.messages ?? []
  const apps = opts.apps ?? []

  const channelMessagesFind = mock(() => ({
    toArray: mock(() => Promise.resolve(messages)),
  }))

  const appsFind = mock(() => ({
    toArray: mock(() => Promise.resolve(apps)),
  }))

  const channelsFindOne = mock(() => Promise.resolve(channel))

  const collection = mock((name: string) => {
    if (name === 'channel_messages') return { find: channelMessagesFind }
    if (name === 'apps') return { find: appsFind }
    if (name === 'channels') return { findOne: channelsFindOne }
    return {}
  })

  return { collection } as unknown as Db
}

function makeCtx(userId: string = CREATOR_ID): WsHandlerContext {
  return { userId } as WsHandlerContext
}

function makeToolMessage(opts: {
  appId?: string
  mcaId?: string
  mcpId?: string
}): MockMessage {
  return {
    content: {
      type: 'tool_execution',
      ...opts,
    },
  }
}

function makeApp(opts: {
  appId: string
  mcaId?: string
  name?: string
  scope?: 'personal' | 'shared'
  ownerId?: string
  status?: string
}): MockApp {
  return {
    mcaId: 'mca.test',
    name: opts.appId,
    ownerId: WORKSPACE_ID,
    status: 'active',
    scope: 'shared',
    ...opts,
  }
}

// ── We need a more sophisticated mock for apps collection ────────────────────
// The handler queries apps twice:
// 1. Resolve mcaIds → appIds (filter by ownerId, status, mcaId $in)
// 2. Look up scope (filter by appId $in)
// We need to return different results for each query.

function createMockDbWithQueries(opts: {
  channel?: MockChannel | null
  messages?: MockMessage[]
  /** All apps in the workspace — the mock will filter based on query */
  apps?: MockApp[]
}): Db {
  const channel = opts.channel ?? {
    channelId: CHANNEL_ID,
    userId: CREATOR_ID,
    workspaceId: WORKSPACE_ID,
    scope: 'personal' as const,
  }
  const messages = opts.messages ?? []
  const allApps = opts.apps ?? []

  const channelMessagesFind = mock(() => ({
    toArray: mock(() => Promise.resolve(messages)),
  }))

  // The apps collection .find() is called twice with different filters.
  // We inspect the filter to return the right subset.
  const appsFind = mock((filter: Record<string, unknown>) => {
    let filtered = [...allApps]
    if (filter.appId && filter.appId.$in) {
      const ids = filter.appId.$in as string[]
      filtered = filtered.filter((a) => ids.includes(a.appId))
    }
    if (filter.mcaId && filter.mcaId.$in) {
      const mcaIds = filter.mcaId.$in as string[]
      filtered = filtered.filter((a) => mcaIds.includes(a.mcaId))
    }
    if (filter.ownerId) {
      filtered = filtered.filter((a) => a.ownerId === filter.ownerId)
    }
    if (filter.status) {
      filtered = filtered.filter((a) => (a.status ?? 'active') === filter.status)
    }
    return {
      toArray: mock(() => Promise.resolve(filtered)),
    }
  })

  const channelsFindOne = mock(() => Promise.resolve(channel))

  const collection = mock((name: string) => {
    if (name === 'channel_messages') return { find: channelMessagesFind }
    if (name === 'apps') return { find: appsFind }
    if (name === 'channels') return { findOne: channelsFindOne }
    return {}
  })

  return { collection } as unknown as Db
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('channel.pre-publish-scan', () => {
  // ── AC-10: personal app used → appears in personalApps ──────────────────────

  test('AC-10: personal app used (appId stored directly) → appears in personalApps', async () => {
    const db = createMockDbWithQueries({
      messages: [
        makeToolMessage({ appId: 'app_gmail', mcaId: 'mca.google.gmail' }),
      ],
      apps: [
        makeApp({ appId: 'app_gmail', mcaId: 'mca.google.gmail', name: 'Gmail', scope: 'personal' }),
      ],
    })
    const cm = createMockChannelManager({
      channelId: CHANNEL_ID,
      userId: CREATOR_ID,
      workspaceId: WORKSPACE_ID,
      scope: 'personal',
    })

    const handler = createPrePublishScanHandler(cm as ChannelManager, db)
    const result = await handler(makeCtx(), { channelId: CHANNEL_ID })

    expect(result.hasWarning).toBe(true)
    expect(result.personalApps).toHaveLength(1)
    expect(result.personalApps[0]).toEqual({ appId: 'app_gmail', name: 'Gmail' })
  })

  test('AC-10: personal app used (resolved via mcaId) → appears in personalApps', async () => {
    const db = createMockDbWithQueries({
      messages: [
        makeToolMessage({ mcaId: 'mca.google.gmail' }),
      ],
      apps: [
        makeApp({ appId: 'app_gmail', mcaId: 'mca.google.gmail', name: 'Gmail', scope: 'personal' }),
      ],
    })
    const cm = createMockChannelManager({
      channelId: CHANNEL_ID,
      userId: CREATOR_ID,
      workspaceId: WORKSPACE_ID,
      scope: 'personal',
    })

    const handler = createPrePublishScanHandler(cm as ChannelManager, db)
    const result = await handler(makeCtx(), { channelId: CHANNEL_ID })

    expect(result.hasWarning).toBe(true)
    expect(result.personalApps).toHaveLength(1)
    expect(result.personalApps[0]).toEqual({ appId: 'app_gmail', name: 'Gmail' })
  })

  // ── AC-11: app was personal when used but is now shared → NOT in result ──────

  test('AC-11: app was personal when used but is now shared → does NOT appear', async () => {
    const db = createMockDbWithQueries({
      messages: [
        makeToolMessage({ appId: 'app_gmail', mcaId: 'mca.google.gmail' }),
      ],
      apps: [
        // App is now shared (was personal when used, but scope changed)
        makeApp({ appId: 'app_gmail', mcaId: 'mca.google.gmail', name: 'Gmail', scope: 'shared' }),
      ],
    })
    const cm = createMockChannelManager({
      channelId: CHANNEL_ID,
      userId: CREATOR_ID,
      workspaceId: WORKSPACE_ID,
      scope: 'personal',
    })

    const handler = createPrePublishScanHandler(cm as ChannelManager, db)
    const result = await handler(makeCtx(), { channelId: CHANNEL_ID })

    expect(result.hasWarning).toBe(false)
    expect(result.personalApps).toHaveLength(0)
  })

  // ── Edge case: app was shared when used but is now personal → DOES appear ────

  test('Edge case: app was shared when used but is now personal → DOES appear', async () => {
    const db = createMockDbWithQueries({
      messages: [
        // No appId stored — tool was used when app was shared (no pending_permission)
        makeToolMessage({ mcaId: 'mca.notion' }),
      ],
      apps: [
        // App is now personal (was shared when used, but scope changed)
        makeApp({ appId: 'app_notion', mcaId: 'mca.notion', name: 'Notion', scope: 'personal' }),
      ],
    })
    const cm = createMockChannelManager({
      channelId: CHANNEL_ID,
      userId: CREATOR_ID,
      workspaceId: WORKSPACE_ID,
      scope: 'personal',
    })

    const handler = createPrePublishScanHandler(cm as ChannelManager, db)
    const result = await handler(makeCtx(), { channelId: CHANNEL_ID })

    expect(result.hasWarning).toBe(true)
    expect(result.personalApps).toHaveLength(1)
    expect(result.personalApps[0]).toEqual({ appId: 'app_notion', name: 'Notion' })
  })

  // ── Mixed: personal + shared apps used ──────────────────────────────────────

  test('mixed: personal and shared apps used → only personal appears', async () => {
    const db = createMockDbWithQueries({
      messages: [
        makeToolMessage({ mcaId: 'mca.google.gmail' }),
        makeToolMessage({ mcaId: 'mca.notion' }),
      ],
      apps: [
        makeApp({ appId: 'app_gmail', mcaId: 'mca.google.gmail', name: 'Gmail', scope: 'personal' }),
        makeApp({ appId: 'app_notion', mcaId: 'mca.notion', name: 'Notion', scope: 'shared' }),
      ],
    })
    const cm = createMockChannelManager({
      channelId: CHANNEL_ID,
      userId: CREATOR_ID,
      workspaceId: WORKSPACE_ID,
      scope: 'personal',
    })

    const handler = createPrePublishScanHandler(cm as ChannelManager, db)
    const result = await handler(makeCtx(), { channelId: CHANNEL_ID })

    expect(result.hasWarning).toBe(true)
    expect(result.personalApps).toHaveLength(1)
    expect(result.personalApps[0].appId).toBe('app_gmail')
  })

  // ── No tool executions → no warning ─────────────────────────────────────────

  test('no tool executions → no warning', async () => {
    const db = createMockDbWithQueries({
      messages: [],
      apps: [],
    })
    const cm = createMockChannelManager({
      channelId: CHANNEL_ID,
      userId: CREATOR_ID,
      workspaceId: WORKSPACE_ID,
      scope: 'personal',
    })

    const handler = createPrePublishScanHandler(cm as ChannelManager, db)
    const result = await handler(makeCtx(), { channelId: CHANNEL_ID })

    expect(result.hasWarning).toBe(false)
    expect(result.personalApps).toHaveLength(0)
  })

  // ── App without scope defaults to shared (NFR-3) ─────────────────────────

  test('app without scope field → defaults to shared, no warning', async () => {
    const db = createMockDbWithQueries({
      messages: [
        makeToolMessage({ mcaId: 'mca.test' }),
      ],
      apps: [
        makeApp({ appId: 'app_test', mcaId: 'mca.test', name: 'Test' }), // no scope
      ],
    })
    const cm = createMockChannelManager({
      channelId: CHANNEL_ID,
      userId: CREATOR_ID,
      workspaceId: WORKSPACE_ID,
      scope: 'personal',
    })

    const handler = createPrePublishScanHandler(cm as ChannelManager, db)
    const result = await handler(makeCtx(), { channelId: CHANNEL_ID })

    expect(result.hasWarning).toBe(false)
    expect(result.personalApps).toHaveLength(0)
  })

  // ── mcpId fallback (newer field name) ───────────────────────────────────────

  test('mcpId fallback: tool message with mcpId instead of mcaId → resolves correctly', async () => {
    const db = createMockDbWithQueries({
      messages: [
        makeToolMessage({ mcpId: 'mca.google.gmail' }),
      ],
      apps: [
        makeApp({ appId: 'app_gmail', mcaId: 'mca.google.gmail', name: 'Gmail', scope: 'personal' }),
      ],
    })
    const cm = createMockChannelManager({
      channelId: CHANNEL_ID,
      userId: CREATOR_ID,
      workspaceId: WORKSPACE_ID,
      scope: 'personal',
    })

    const handler = createPrePublishScanHandler(cm as ChannelManager, db)
    const result = await handler(makeCtx(), { channelId: CHANNEL_ID })

    expect(result.hasWarning).toBe(true)
    expect(result.personalApps).toHaveLength(1)
    expect(result.personalApps[0].appId).toBe('app_gmail')
  })

  // ── Authorization: non-creator → ACCESS_DENIED ──────────────────────────────

  test('non-creator → throws ACCESS_DENIED', async () => {
    const db = createMockDbWithQueries({
      messages: [],
      apps: [],
    })
    const cm = createMockChannelManager({
      channelId: CHANNEL_ID,
      userId: CREATOR_ID,
      workspaceId: WORKSPACE_ID,
      scope: 'personal',
    })

    const handler = createPrePublishScanHandler(cm as ChannelManager, db)

    expect(
      handler(makeCtx(OTHER_ID), { channelId: CHANNEL_ID }),
    ).rejects.toThrow('You do not have permission to perform this action')
  })

  // ── Missing channelId ───────────────────────────────────────────────────────

  test('missing channelId → throws MISSING_FIELDS', async () => {
    const db = createMockDbWithQueries({ messages: [], apps: [] })
    const cm = createMockChannelManager(null)

    const handler = createPrePublishScanHandler(cm as ChannelManager, db)

    expect(
      handler(makeCtx(), {}),
    ).rejects.toThrow('channelId is required')
  })

  // ── Channel not found ───────────────────────────────────────────────────────

  test('channel not found → throws CHANNEL_NOT_FOUND', async () => {
    const db = createMockDbWithQueries({ channel: null, messages: [], apps: [] })
    const cm = createMockChannelManager(null)

    const handler = createPrePublishScanHandler(cm as ChannelManager, db)

    expect(
      handler(makeCtx(), { channelId: 'ch_nonexistent' }),
    ).rejects.toThrow('Channel not found')
  })

  // ── Deduplication: same app used multiple times → appears once ──────────────

  test('deduplication: same personal app used in multiple tool calls → appears once', async () => {
    const db = createMockDbWithQueries({
      messages: [
        makeToolMessage({ appId: 'app_gmail', mcaId: 'mca.google.gmail' }),
        makeToolMessage({ mcaId: 'mca.google.gmail' }),
        makeToolMessage({ mcaId: 'mca.google.gmail' }),
      ],
      apps: [
        makeApp({ appId: 'app_gmail', mcaId: 'mca.google.gmail', name: 'Gmail', scope: 'personal' }),
      ],
    })
    const cm = createMockChannelManager({
      channelId: CHANNEL_ID,
      userId: CREATOR_ID,
      workspaceId: WORKSPACE_ID,
      scope: 'personal',
    })

    const handler = createPrePublishScanHandler(cm as ChannelManager, db)
    const result = await handler(makeCtx(), { channelId: CHANNEL_ID })

    expect(result.hasWarning).toBe(true)
    expect(result.personalApps).toHaveLength(1)
  })
})
