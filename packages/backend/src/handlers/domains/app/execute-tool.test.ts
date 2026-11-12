/**
 * Unit tests for the personal-app gate in app.execute-tool (REQ-7, AC-8, AC-9).
 *
 * AC-8: Personal app blocked in public conversation
 *   - Channel is public, app is personal → tool execution blocked
 *   - Error code: PERSONAL_APP_BLOCKED
 *
 * AC-9: Personal app works in private conversation
 *   - Channel is private, app is personal → tool execution succeeds
 *
 * Also tests:
 * - NFR-3 (rev2): channel without scope → treated as personal → personal app allowed
 * - Shared app in public channel → not blocked
 * - No channelId in input → gate not triggered (no channel context)
 */

import { describe, expect, test, mock } from 'bun:test'
import type { Db } from 'mongodb'
import { createExecuteToolHandler } from './execute-tool'
import type { McaService } from '../../../services/mca-service'
import type { McaManager } from '../../../services/mca-manager'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { PubSubService } from '../../../services/pubsub-service'
import type { WsHandlerContext } from '@teros/shared'
import { HandlerError } from '../../../ws-framework/WsRouter'

// ─── Mock helpers ──────────────────────────────────────────────────────────────

const USER_ID = 'user_test'
const APP_ID = 'app_gmail'
const WORKSPACE_ID = 'ws_test'
const CHANNEL_ID = 'ch_test123'

interface MockApp {
  appId: string
  name: string
  mcaId: string
  ownerId: string
  installedBy?: string
  scope?: 'personal' | 'shared'
  status?: string
}

interface MockChannel {
  channelId: string
  userId: string
  workspaceId: string
  scope?: 'personal' | 'shared'
}

function makeCtx(userId: string = USER_ID): WsHandlerContext {
  return { userId, sessionId: 'sess_test', ip: '127.0.0.1' } as WsHandlerContext
}

// The channel the mock db serves — the service mock applies the MUW-REQ-12 rule against it.
let currentChannel: MockChannel | null = null
function createMockMcaService(app: MockApp | null): Pick<McaService, 'getApp' | 'isAppVisibleTo' | 'isAppBlockedInChannel'> {
  return {
    getApp: mock(() => Promise.resolve(app as any)),
    isAppVisibleTo: (a: any, userId: string) => a.scope === 'shared' || a.installedBy === userId,
    isAppBlockedInChannel: async (a: any, _channelId: string) => {
      if (a.scope === 'shared') return false
      if (a.scope !== 'personal') return true
      if (!currentChannel) return true
      if ((currentChannel.scope ?? 'personal') === 'shared') return true
      return a.installedBy !== currentChannel.userId
    },
  }
}

function createMockWorkspaceService(canAccessResult: boolean = true): Pick<WorkspaceService, 'canAccess'> {
  return {
    canAccess: mock(() => canAccessResult),
  }
}

function createMockMcaManager(executeResult: any = null): Pick<McaManager, 'executeTool'> {
  return {
    executeTool: mock(() => Promise.resolve(executeResult ?? {
      output: JSON.stringify({ success: true }),
      isError: false,
      mcaId: 'mca.teros.gmail',
    })),
  }
}


function createMockDb(channel: MockChannel | null): Db {
  currentChannel = channel
  const channelsFindOne = mock(() => Promise.resolve(channel))
  const collection = mock((name: string) => {
    if (name === 'channels') return { findOne: channelsFindOne }
    return {}
  })
  return { collection } as unknown as Db
}

function makeApp(overrides: Partial<MockApp> = {}): MockApp {
  return {
    appId: APP_ID,
    name: 'gmail',
    mcaId: 'mca.teros.gmail',
    ownerId: WORKSPACE_ID,
    installedBy: USER_ID,
    scope: 'personal',
    status: 'active',
    ...overrides,
  }
}

function makeChannel(overrides: Partial<MockChannel> = {}): MockChannel {
  return {
    channelId: CHANNEL_ID,
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    scope: 'shared',
    ...overrides,
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('app.execute-tool: personal-app gate (REQ-7, AC-8, AC-9)', () => {
  // ── AC-8: Personal app blocked in public conversation ────────────────────────

  test('AC-8: personal app in public channel → throws PERSONAL_APP_BLOCKED', async () => {
    const app = makeApp({ scope: 'personal' })
    const channel = makeChannel({ scope: 'shared' })

    const mcaService = createMockMcaService(app)
    const workspaceService = createMockWorkspaceService(true)
    const mcaManager = createMockMcaManager()
    const db = createMockDb(channel)

    const handler = createExecuteToolHandler(
      mcaService as McaService,
      mcaManager as McaManager,
      workspaceService as WorkspaceService,
      null as any,
      db,
    )

    try {
      await handler(makeCtx(), {
        appId: APP_ID,
        tool: 'search',
        input: { channelId: CHANNEL_ID, query: 'test' },
      })
      expect(false).toBe(true) // Should not reach here
    } catch (e) {
      expect(e).toBeInstanceOf(HandlerError)
      expect((e as HandlerError).code).toBe('PERSONAL_APP_BLOCKED')
      expect((e as HandlerError).message).toContain('This personal app cannot be used in this conversation')
    }
  })

  // ── AC-9: Personal app works in private conversation ─────────────────────────

  test('AC-9: personal app in private channel → tool execution succeeds', async () => {
    const app = makeApp({ scope: 'personal' })
    const channel = makeChannel({ scope: 'personal' })

    const mcaService = createMockMcaService(app)
    const workspaceService = createMockWorkspaceService(true)
    const mcaManager = createMockMcaManager()
    const db = createMockDb(channel)

    const handler = createExecuteToolHandler(
      mcaService as McaService,
      mcaManager as McaManager,
      workspaceService as WorkspaceService,
      null as any,
      db,
    )

    const result = await handler(makeCtx(), {
      appId: APP_ID,
      tool: 'search',
      input: { channelId: CHANNEL_ID, query: 'test' },
    })

    expect(result.success).toBe(true)
  })

  // ── NFR-3 (rev2): Channel without scope → treated as personal → personal app allowed ──

  test('NFR-3 (rev2): personal app in channel without scope field → succeeds (treated as personal)', async () => {
    const app = makeApp({ scope: 'personal' })
    // Channel with no scope field — legacy channel, treated as personal per NFR-3 rev2
    const channel = makeChannel()
    delete (channel as any).scope

    const mcaService = createMockMcaService(app)
    const workspaceService = createMockWorkspaceService(true)
    const mcaManager = createMockMcaManager()
    const db = createMockDb(channel)

    const handler = createExecuteToolHandler(
      mcaService as McaService,
      mcaManager as McaManager,
      workspaceService as WorkspaceService,
      null as any,
      db,
    )

    const result = await handler(makeCtx(), {
      appId: APP_ID,
      tool: 'search',
      input: { channelId: CHANNEL_ID, query: 'test' },
    })
    expect(result.success).toBe(true)
  })

  // ── Shared app in public channel → not blocked ───────────────────────────────

  test('shared app in public channel → tool execution succeeds (no gate)', async () => {
    const app = makeApp({ scope: 'shared' })
    const channel = makeChannel({ scope: 'shared' })

    const mcaService = createMockMcaService(app)
    const workspaceService = createMockWorkspaceService(true)
    const mcaManager = createMockMcaManager()
    const db = createMockDb(channel)

    const handler = createExecuteToolHandler(
      mcaService as McaService,
      mcaManager as McaManager,
      workspaceService as WorkspaceService,
      null as any,
      db,
    )

    const result = await handler(makeCtx(), {
      appId: APP_ID,
      tool: 'search',
      input: { channelId: CHANNEL_ID, query: 'test' },
    })

    expect(result.success).toBe(true)
  })

  // ── No channelId in input → gate not triggered ───────────────────────────────

  test('personal app with no channelId in input → gate not triggered, execution proceeds', async () => {
    const app = makeApp({ scope: 'personal' })
    const channel = makeChannel({ scope: 'shared' })

    const mcaService = createMockMcaService(app)
    const workspaceService = createMockWorkspaceService(true)
    const mcaManager = createMockMcaManager()
    const db = createMockDb(channel)

    const handler = createExecuteToolHandler(
      mcaService as McaService,
      mcaManager as McaManager,
      workspaceService as WorkspaceService,
      null as any,
      db,
    )

    // No channelId in input — the gate checks `input.channelId` which is undefined
    const result = await handler(makeCtx(), {
      appId: APP_ID,
      tool: 'search',
      input: { query: 'test' }, // no channelId
    })

    expect(result.success).toBe(true)
  })

  // ── Personal app in channel with null visibility → treated as personal → allowed ──

  test('personal app in channel with scope: null → succeeds (null ?? personal = private)', async () => {
    const app = makeApp({ scope: 'personal' })
    const channel = makeChannel({ scope: null as any })

    const mcaService = createMockMcaService(app)
    const workspaceService = createMockWorkspaceService(true)
    const mcaManager = createMockMcaManager()
    const db = createMockDb(channel)

    const handler = createExecuteToolHandler(
      mcaService as McaService,
      mcaManager as McaManager,
      workspaceService as WorkspaceService,
      null as any,
      db,
    )

    const result = await handler(makeCtx(), {
      appId: APP_ID,
      tool: 'search',
      input: { channelId: CHANNEL_ID, query: 'test' },
    })
    expect(result.success).toBe(true)
  })

  // ── App without scope → personal (MUW-NFR-3) → blocked in a shared channel ──

  test('[MUW-AC-3] app without scope in shared channel → blocked (missing scope = personal)', async () => {
    const app = makeApp()
    delete (app as any).scope

    const channel = makeChannel({ scope: 'shared' })

    const mcaService = createMockMcaService(app)
    const workspaceService = createMockWorkspaceService(true)
    const mcaManager = createMockMcaManager()
    const db = createMockDb(channel)

    const handler = createExecuteToolHandler(
      mcaService as McaService,
      mcaManager as McaManager,
      workspaceService as WorkspaceService,
      null as any,
      db,
    )

    await expect(
      handler(makeCtx(), { appId: APP_ID, tool: 'search', input: { channelId: CHANNEL_ID, query: 'test' } }),
    ).rejects.toMatchObject({ code: 'PERSONAL_APP_BLOCKED' })
  })

  // ── Channel not found in DB → fail closed ─────────────────────────────────

  test('[MUW-AC-20] personal app when the channel is unknown → blocked (fail closed, no fallback)', async () => {
    const app = makeApp({ scope: 'personal' })

    const mcaService = createMockMcaService(app)
    const workspaceService = createMockWorkspaceService(true)
    const mcaManager = createMockMcaManager()
    const db = createMockDb(null) // channel not found

    const handler = createExecuteToolHandler(
      mcaService as McaService,
      mcaManager as McaManager,
      workspaceService as WorkspaceService,
      null as any,
      db,
    )

    await expect(
      handler(makeCtx(), { appId: APP_ID, tool: 'search', input: { channelId: CHANNEL_ID, query: 'test' } }),
    ).rejects.toMatchObject({ code: 'PERSONAL_APP_BLOCKED' })
  })
})
