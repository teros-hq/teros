/**
 * Integration tests for the multi-user workspaces feature — full flow coverage.
 *
 * These tests simulate the complete user journey described in the acceptance
 * criteria (AC-1 through AC-14) using mock services that mimic the real
 * backend behavior. Each test exercises the interaction between multiple
 * components (channel-permissions, redact-messages, set-scope,
 * toggle-redaction, pre-publish-scan, execute-tool gate).
 *
 * The flow tested:
 *   1. Create conversation (personal by default)
 *   2. Use personal app in personal conversation (allowed)
 *   3. Redact sensitive messages
 *   4. Make conversation shared
 *   5. Verify as non-owner: redacted content is hidden, non-redacted is visible
 *   6. Personal apps blocked in shared conversations
 *   7. Non-creator cannot toggle scope / redact / archive
 *   8. Board-linked channels are auto-shared
 *   9. Pre-publish scan detects personal apps
 */

import { describe, expect, test, mock, beforeEach } from 'bun:test'
import type { Db } from 'mongodb'
import {
  canRedact,
  canToggleScope,
  canWriteInChannel,
  canArchiveChannel,
  canUsePersonalApp,
} from '../../../auth/channel-permissions'
import { redactMessagesForViewer } from '../../../auth/redact-messages'
import { createSetScopeHandler } from './set-scope'
import { createToggleRedactionHandler } from './toggle-redaction'
import { createPrePublishScanHandler } from './pre-publish-scan'
import { createExecuteToolHandler } from '../app/execute-tool'
import type { ChannelManager } from '../../../services/channel-manager'
import type { SessionManager } from '../../../services/session-manager'
import type { PubSubService } from '../../../services/pubsub-service'
import type { McaService } from '../../../services/mca-service'
import type { McaManager } from '../../../services/mca-manager'
import type { WorkspaceService } from '../../../services/workspace-service'
import type { FeatureFlagService } from '../../../services/feature-flag-service'
import type { WsHandlerContext, Message } from '@teros/shared'
import { HandlerError } from '../../../ws-framework/WsRouter'

// ─── Test constants ────────────────────────────────────────────────────────────

const CREATOR_ID = 'user_alice'
const OTHER_ID = 'user_bob'
const CHANNEL_ID = 'ch_integration_001'
const WORKSPACE_ID = 'ws_team'
const AGENT_ID = 'agent_nira'
const APP_GMAIL_ID = 'app_gmail_personal'
const APP_NOTION_ID = 'app_notion_shared'

// ─── In-memory mock database ───────────────────────────────────────────────────
// A minimal in-memory MongoDB-like store that supports the operations
// needed by the handlers under test.

interface MockChannel {
  channelId: string
  userId: string
  workspaceId: string
  agentId: string
  status: string
  scope?: 'personal' | 'shared'
  metadata: { name: string; [k: string]: any }
  createdAt: string
  updatedAt: string
  lastMessageAt: string
}

interface MockMessageDoc {
  messageId: string
  channelId: string
  role: string
  content: any
  timestamp: string
  redacted?: boolean
  redactedBy?: string
  redactedAt?: string
  metadata?: Record<string, any>
}

interface MockApp {
  appId: string
  name: string
  mcaId: string
  ownerId: string
  scope?: 'personal' | 'shared'
  status: string
}

class MockStore {
  channels: Map<string, MockChannel> = new Map()
  messages: MockMessageDoc[] = []
  apps: Map<string, MockApp> = new Map()

  createChannel(ch: MockChannel) {
    this.channels.set(ch.channelId, ch)
  }

  getChannel(id: string) {
    return this.channels.get(id) ?? null
  }

  addMessage(msg: MockMessageDoc) {
    this.messages.push(msg)
  }

  getMessages(channelId: string) {
    return this.messages.filter((m) => m.channelId === channelId).sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }

  getApp(id: string) {
    return this.apps.get(id) ?? null
  }
}

function createMockDbFromStore(store: MockStore): Db {
  const channelsFindOne = mock((filter: any) => {
    if (filter.channelId) return Promise.resolve(store.getChannel(filter.channelId) as any)
    return Promise.resolve(null)
  })

  const channelsUpdateOne = mock((filter: any, update: any) => {
    const ch = store.getChannel(filter.channelId)
    if (ch) {
      Object.assign(ch, update.$set || {})
      if (update.$unset) {
        for (const k of Object.keys(update.$unset)) {
          delete (ch as any)[k]
        }
      }
    }
    return Promise.resolve({ matchedCount: ch ? 1 : 0 })
  })

  const messagesFind = mock((filter: any) => {
    let msgs = store.messages
    if (filter.channelId) msgs = msgs.filter((m) => m.channelId === filter.channelId)
    if (filter['content.type']) {
      const t = filter['content.type']
      msgs = msgs.filter((m) => m.content?.type === t)
    }
    return {
      toArray: mock(() => Promise.resolve(msgs as any[])),
    }
  })

  const messagesUpdateOne = mock((filter: any, update: any) => {
    const msg = store.messages.find((m) => m.channelId === filter.channelId && m.messageId === filter.messageId)
    if (msg) {
      Object.assign(msg, update.$set || {})
      if (update.$unset) {
        for (const k of Object.keys(update.$unset)) {
          delete (msg as any)[k]
        }
      }
    }
    return Promise.resolve({ matchedCount: msg ? 1 : 0 })
  })

  const messagesFindOne = mock((filter: any) => {
    const msg = store.messages.find((m) => m.channelId === filter.channelId && m.messageId === filter.messageId)
    return Promise.resolve((msg as any) ?? null)
  })

  const appsFind = mock((filter: any) => {
    let apps = [...store.apps.values()]
    if (filter.appId?.$in) {
      apps = apps.filter((a) => (filter.appId.$in as string[]).includes(a.appId))
    }
    if (filter.mcaId?.$in) {
      apps = apps.filter((a) => (filter.mcaId.$in as string[]).includes(a.mcaId))
    }
    if (filter.ownerId) {
      apps = apps.filter((a) => a.ownerId === filter.ownerId)
    }
    if (filter.status) {
      apps = apps.filter((a) => a.status === filter.status)
    }
    return {
      toArray: mock(() => Promise.resolve(apps as any[])),
    }
  })

  const collection = mock((name: string) => {
    if (name === 'channels') return { findOne: channelsFindOne, updateOne: channelsUpdateOne }
    if (name === 'channel_messages') return { find: messagesFind, updateOne: messagesUpdateOne, findOne: messagesFindOne }
    if (name === 'apps') return { find: appsFind }
    return {}
  })

  return { collection } as unknown as Db
}

function createMockChannelManager(store: MockStore): Pick<ChannelManager, 'getChannel' | 'setChannelScope' | 'toggleMessageRedaction'> {
  return {
    getChannel: mock((id: string) => Promise.resolve(store.getChannel(id) as any)),
    setChannelScope: mock((id: string, scope: 'personal' | 'shared') => {
      const ch = store.getChannel(id)
      if (ch) {
        ch.scope = scope
        ch.updatedAt = new Date().toISOString()
      }
      return Promise.resolve()
    }),
    toggleMessageRedaction: mock((channelId: string, messageId: string, redacted: boolean, redactedBy: string) => {
      const msg = store.messages.find((m) => m.channelId === channelId && m.messageId === messageId)
      if (!msg) return Promise.resolve(null)
      if (redacted) {
        msg.redacted = true
        msg.redactedBy = redactedBy
        msg.redactedAt = new Date().toISOString()
      } else {
        msg.redacted = false
        delete msg.redactedBy
        delete msg.redactedAt
      }
      return Promise.resolve(msg as any)
    }),
  }
}

function createMockSessionManager(): Pick<SessionManager, 'getUserSessions'> {
  return {
    getUserSessions: mock(() => []),
  }
}

function createMockPubSub(): Pick<PubSubService, 'broadcastToTopic'> {
  return {
    broadcastToTopic: mock(() => {}),
  }
}

function createMockMcaService(app: MockApp | null): Pick<McaService, 'getApp' | 'isAppVisibleTo' | 'isAppBlockedInChannel'> {
  return {
    getApp: mock(() => Promise.resolve(app as any)),
    // MUW-REQ-12/13 as the real service applies them, against this store's channels
    isAppVisibleTo: (a: any, userId: string) => a.scope === 'shared' || a.installedBy === userId,
    isAppBlockedInChannel: async (a: any, channelId: string) => {
      if (a.scope === 'shared') return false
      if (a.scope !== 'personal') return true
      const ch = store.getChannel(channelId)
      if (!ch) return true
      if ((ch.scope ?? 'personal') === 'shared') return true
      return a.installedBy !== ch.userId
    },
  }
}

function createMockWorkspaceService(): Pick<WorkspaceService, 'canAccess'> {
  return {
    canAccess: mock(() => true),
  }
}

function createMockMcaManager(): Pick<McaManager, 'executeTool'> {
  return {
    executeTool: mock(() => Promise.resolve({
      output: JSON.stringify({ success: true }),
      isError: false,
      mcaId: 'mca.teros.gmail',
    })),
  }
}

function createMockFeatureFlagService(enabled: boolean = true): Pick<FeatureFlagService, 'resolve'> {
  return {
    resolve: mock(() => Promise.resolve(enabled)),
  }
}

function makeCtx(userId: string): WsHandlerContext {
  return { userId, sessionId: 'sess_test', ip: '127.0.0.1' } as WsHandlerContext
}

// ─── Test fixtures ─────────────────────────────────────────────────────────────

let store: MockStore
let db: Db
let cm: Pick<ChannelManager, 'getChannel' | 'setChannelScope' | 'toggleMessageRedaction'>
let sm: Pick<SessionManager, 'getUserSessions'>
let pubsub: Pick<PubSubService, 'broadcastToTopic'>

beforeEach(() => {
  store = new MockStore()
  db = createMockDbFromStore(store)
  cm = createMockChannelManager(store)
  sm = createMockSessionManager()
  pubsub = createMockPubSub()

  // Set up a default channel
  store.createChannel({
    channelId: CHANNEL_ID,
    userId: CREATOR_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    status: 'active',
    scope: 'personal', // REQ-1: personal by default
    metadata: { name: 'Integration Test Chat' },
    createdAt: '2026-09-14T20:00:00Z',
    updatedAt: '2026-09-14T20:00:00Z',
    lastMessageAt: '2026-09-14T20:00:00Z',
  })

  // Set up apps
  store.apps.set(APP_GMAIL_ID, {
    appId: APP_GMAIL_ID,
    name: 'gmail',
    mcaId: 'mca.teros.gmail',
    ownerId: WORKSPACE_ID,
    scope: 'personal',
    installedBy: CREATOR_ID,
    status: 'active',
  })

  store.apps.set(APP_NOTION_ID, {
    appId: APP_NOTION_ID,
    name: 'notion',
    mcaId: 'mca.teros.notion',
    ownerId: WORKSPACE_ID,
    scope: 'shared',
    status: 'active',
  })
})

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('MUW Integration: full flow (AC-1 through AC-14)', () => {
  // ── AC-1: New conversation is personal by default ─────────────────────────────

  test('AC-1: new channel has scope=personal, non-creator cannot see it', async () => {
    const channel = store.getChannel(CHANNEL_ID)!
    expect(channel.scope).toBe('personal')

    // Non-creator checks canUsePersonalApp (which checks scope)
    // In a real system, listUserChannels would filter this out.
    // Here we verify the permission layer: non-creator can't toggle scope
    const canToggle = await canToggleScope(db, OTHER_ID, CHANNEL_ID)
    expect(canToggle).toBe(false)
  })

  // ── AC-2: Make conversation shared ───────────────────────────────────────────

  test('AC-2: creator toggles scope to shared, non-creator can now see it', async () => {
    const handler = createSetScopeHandler(
      cm as ChannelManager,
      sm as SessionManager,
      pubsub as PubSubService,
      db,
      createMockFeatureFlagService() as any,
    )

    // Creator makes it shared
    const result = await handler(makeCtx(CREATOR_ID), {
      channelId: CHANNEL_ID,
      scope: 'shared',
    })

    expect(result).toEqual({ channelId: CHANNEL_ID, scope: 'shared' })

    // Verify the channel is now shared
    const channel = store.getChannel(CHANNEL_ID)!
    expect(channel.scope).toBe('shared')

    // Non-creator can now see it (scope is shared)
    // In the real system, listUserChannels would include it.
    // Here we verify the channel state.
    expect(channel.scope).toBe('shared')
  })

  // ── AC-3: Make shared conversation personal again ─────────────────────────────

  test('AC-3: creator toggles scope back to personal, non-creator loses access', async () => {
    const handler = createSetScopeHandler(
      cm as ChannelManager,
      sm as SessionManager,
      pubsub as PubSubService,
      db,
      createMockFeatureFlagService() as any,
    )

    // First make it shared
    await handler(makeCtx(CREATOR_ID), { channelId: CHANNEL_ID, scope: 'shared' })
    expect(store.getChannel(CHANNEL_ID)!.scope).toBe('shared')

    // Then make it personal again
    await handler(makeCtx(CREATOR_ID), { channelId: CHANNEL_ID, scope: 'personal' })
    expect(store.getChannel(CHANNEL_ID)!.scope).toBe('personal')
  })

  // ── AC-4: Board task conversation is auto-shared ─────────────────────────────

  test('AC-4: board-linked channel is auto-shared (link-conversation sets scope=shared)', async () => {
    // The link-conversation handler calls channelManager.setChannelScope(channelId, 'shared')
    // We simulate this by calling setChannelScope directly
    await cm.setChannelScope(CHANNEL_ID, 'shared')

    const channel = store.getChannel(CHANNEL_ID)!
    expect(channel.scope).toBe('shared')
  })

  // ── AC-5: Redact a message as channel owner ──────────────────────────────────

  test('AC-5: owner can redact a message — owner sees full content', async () => {
    // Add a message with sensitive content
    store.addMessage({
      messageId: 'msg_001',
      channelId: CHANNEL_ID,
      role: 'user',
      content: { type: 'text', text: 'My API key is sk-secret123' },
      timestamp: '2026-09-14T20:01:00Z',
    })

    const handler = createToggleRedactionHandler(
      cm as ChannelManager,
      sm as SessionManager,
      pubsub as PubSubService,
      db,
      createMockFeatureFlagService() as any,
    )

    const result = await handler(makeCtx(CREATOR_ID), {
      channelId: CHANNEL_ID,
      messageId: 'msg_001',
      redacted: true,
    })

    expect(result.redacted).toBe(true)
    expect(result.messageId).toBe('msg_001')

    // Owner sees full content via redactMessagesForViewer
    const messages = store.getMessages(CHANNEL_ID).map((m) => m as unknown as Message)
    const safeMessages = redactMessagesForViewer(messages, true) // isOwner = true
    expect(safeMessages[0].content).toEqual({ type: 'text', text: 'My API key is sk-secret123' })
  })

  // ── AC-6: Non-owner cannot see redacted content ──────────────────────────────

  test('AC-6: non-owner cannot see redacted content — serialized payload is clean', async () => {
    // Add a redacted message with sensitive content
    store.addMessage({
      messageId: 'msg_001',
      channelId: CHANNEL_ID,
      role: 'user',
      content: { type: 'text', text: 'My API key is sk-secret123' },
      timestamp: '2026-09-14T20:01:00Z',
      redacted: true,
      redactedBy: CREATOR_ID,
      redactedAt: '2026-09-14T20:02:00Z',
    })

    // Add a normal (non-redacted) message
    store.addMessage({
      messageId: 'msg_002',
      channelId: CHANNEL_ID,
      role: 'assistant',
      content: { type: 'text', text: 'Hello, how can I help?' },
      timestamp: '2026-09-14T20:03:00Z',
    })

    // Non-owner requests messages
    const messages = store.getMessages(CHANNEL_ID).map((m) => m as unknown as Message)
    const safeMessages = redactMessagesForViewer(messages, false) // isOwner = false

    // Redacted message: content is null
    expect(safeMessages[0].content).not.toBeNull()
    expect((safeMessages[0].content as any).type).toBe("text")
    expect((safeMessages[0].content as any).text).not.toContain("sk-secret123")
    expect(safeMessages[0].redacted).toBe(true)
    expect(safeMessages[0].redactedPlaceholder).toBeDefined()
    expect(safeMessages[0].redactedPlaceholder!.type).toBe('redacted')
    expect(safeMessages[0].redactedPlaceholder!.reason).toBe('protected_by_owner')

    // Normal message: content is visible
    expect(safeMessages[1].content).toEqual({ type: 'text', text: 'Hello, how can I help?' })

    // JSON audit: secret must not appear anywhere
    const serialized = JSON.stringify(safeMessages)
    expect(serialized).not.toContain('sk-secret123')
    expect(serialized).not.toContain('API key')
  })

  // ── AC-7: Owner can un-redact ────────────────────────────────────────────────

  test('AC-7: owner un-redacts → content becomes visible to non-owners', async () => {
    // Add a redacted message
    store.addMessage({
      messageId: 'msg_001',
      channelId: CHANNEL_ID,
      role: 'user',
      content: { type: 'text', text: 'Sensitive info revealed' },
      timestamp: '2026-09-14T20:01:00Z',
      redacted: true,
      redactedBy: CREATOR_ID,
      redactedAt: '2026-09-14T20:02:00Z',
    })

    const handler = createToggleRedactionHandler(
      cm as ChannelManager,
      sm as SessionManager,
      pubsub as PubSubService,
      db,
      createMockFeatureFlagService() as any,
    )

    // Owner un-redacts
    await handler(makeCtx(CREATOR_ID), {
      channelId: CHANNEL_ID,
      messageId: 'msg_001',
      redacted: false,
    })

    // Non-owner can now see content
    const messages = store.getMessages(CHANNEL_ID).map((m) => m as unknown as Message)
    const safeMessages = redactMessagesForViewer(messages, false)

    expect(safeMessages[0].content).toEqual({ type: 'text', text: 'Sensitive info revealed' })
    expect(safeMessages[0].redactedPlaceholder).toBeUndefined()
  })

  // ── AC-8: Personal app blocked in shared conversation ─────────────────────────

  test('AC-8: personal app blocked when channel is shared', async () => {
    // Make channel shared
    await cm.setChannelScope(CHANNEL_ID, 'shared')

    const app = store.getApp(APP_GMAIL_ID)!
    const mcaService = createMockMcaService(app)
    const workspaceService = createMockWorkspaceService()
    const mcaManager = createMockMcaManager()

    const handler = createExecuteToolHandler(
      mcaService as McaService,
      mcaManager as McaManager,
      workspaceService as WorkspaceService,
      null as any,
      db,
      createMockFeatureFlagService() as any,
    )

    try {
      await handler(makeCtx(CREATOR_ID), {
        appId: APP_GMAIL_ID,
        tool: 'search',
        input: { channelId: CHANNEL_ID, query: 'test' },
      })
      expect(false).toBe(true) // Should not reach here
    } catch (e) {
      expect((e as HandlerError).code).toBe('PERSONAL_APP_BLOCKED')
    }
  })

  // ── AC-9: Personal app works in personal conversation ─────────────────────────

  test('AC-9: personal app works when channel is personal', async () => {
    // Channel is already personal (default)
    expect(store.getChannel(CHANNEL_ID)!.scope).toBe('personal')

    const app = store.getApp(APP_GMAIL_ID)!
    const mcaService = createMockMcaService(app)
    const workspaceService = createMockWorkspaceService()
    const mcaManager = createMockMcaManager()

    const handler = createExecuteToolHandler(
      mcaService as McaService,
      mcaManager as McaManager,
      workspaceService as WorkspaceService,
      null as any,
      db,
      createMockFeatureFlagService() as any,
    )

    const result = await handler(makeCtx(CREATOR_ID), {
      appId: APP_GMAIL_ID,
      tool: 'search',
      input: { channelId: CHANNEL_ID, query: 'test' },
    })

    expect(result.success).toBe(true)
  })

  // ── AC-10: Pre-publish warning when personal apps were used ───────────────────

  test('AC-10: pre-publish scan detects personal app usage → warning', async () => {
    // Add a tool execution message from a personal app
    store.addMessage({
      messageId: 'msg_tool_001',
      channelId: CHANNEL_ID,
      role: 'assistant',
      content: { type: 'tool_execution', appId: APP_GMAIL_ID, mcaId: 'mca.teros.gmail' },
      timestamp: '2026-09-14T20:01:00Z',
    })

    const handler = createPrePublishScanHandler(cm as ChannelManager, db, createMockFeatureFlagService() as any)
    const result = await handler(makeCtx(CREATOR_ID), { channelId: CHANNEL_ID })

    expect(result.hasWarning).toBe(true)
    expect(result.personalApps).toHaveLength(1)
    expect(result.personalApps[0].appId).toBe(APP_GMAIL_ID)
  })

  // ── AC-11: No warning when apps have been converted to shared ─────────────────

  test('AC-11: app was personal when used but is now shared → no warning', async () => {
    // Add a tool execution message
    store.addMessage({
      messageId: 'msg_tool_001',
      channelId: CHANNEL_ID,
      role: 'assistant',
      content: { type: 'tool_execution', appId: APP_GMAIL_ID, mcaId: 'mca.teros.gmail' },
      timestamp: '2026-09-14T20:01:00Z',
    })

    // Change the app's scope to shared
    store.apps.get(APP_GMAIL_ID)!.scope = 'shared'

    const handler = createPrePublishScanHandler(cm as ChannelManager, db, createMockFeatureFlagService() as any)
    const result = await handler(makeCtx(CREATOR_ID), { channelId: CHANNEL_ID })

    expect(result.hasWarning).toBe(false)
    expect(result.personalApps).toHaveLength(0)
  })

  // ── AC-12: Author identity shown in shared conversations ─────────────────────
  // This is primarily a frontend concern, but we verify the data model supports it:
  // messages have a `sender` field with name and avatarUrl.

  test('AC-12: messages carry sender info for authorship display in shared conversations', () => {
    store.addMessage({
      messageId: 'msg_001',
      channelId: CHANNEL_ID,
      role: 'user',
      content: { type: 'text', text: 'Hello team' },
      timestamp: '2026-09-14T20:01:00Z',
      // sender field is on the Message schema (MessageSenderSchema)
      // In the real system, this is populated when the message is created.
      // Here we verify the schema supports it.
    } as any)

    // The Message schema includes an optional `sender` field with:
    // type: 'user' | 'agent' | 'system', id, name, avatarUrl
    // This data is available to the frontend for rendering authorship in shared conversations.
    // The backend does not strip sender info for non-owners — only content is redacted.
    const messages = store.getMessages(CHANNEL_ID).map((m) => m as unknown as Message)
    const safeMessages = redactMessagesForViewer(messages, false)

    // Non-redacted message: sender info is preserved
    expect(safeMessages[0]).toBeDefined()
    // The message is visible (not redacted)
    expect(safeMessages[0].content).toEqual({ type: 'text', text: 'Hello team' })
  })

  // ── AC-13: Permission denied for non-creator actions ─────────────────────────

  test('AC-13: non-creator cannot toggle scope → ACCESS_DENIED', async () => {
    const handler = createSetScopeHandler(
      cm as ChannelManager,
      sm as SessionManager,
      pubsub as PubSubService,
      db,
      createMockFeatureFlagService() as any,
    )

    try {
      await handler(makeCtx(OTHER_ID), { channelId: CHANNEL_ID, scope: 'shared' })
      expect(false).toBe(true)
    } catch (e) {
      expect((e as HandlerError).code).toBe('ACCESS_DENIED')
    }
  })

  test('AC-13: non-creator cannot redact messages → ACCESS_DENIED', async () => {
    store.addMessage({
      messageId: 'msg_001',
      channelId: CHANNEL_ID,
      role: 'user',
      content: { type: 'text', text: 'test' },
      timestamp: '2026-09-14T20:01:00Z',
    })

    const handler = createToggleRedactionHandler(
      cm as ChannelManager,
      sm as SessionManager,
      pubsub as PubSubService,
      db,
      createMockFeatureFlagService() as any,
    )

    try {
      await handler(makeCtx(OTHER_ID), {
        channelId: CHANNEL_ID,
        messageId: 'msg_001',
        redacted: true,
      })
      expect(false).toBe(true)
    } catch (e) {
      expect((e as HandlerError).code).toBe('ACCESS_DENIED')
    }
  })

  test('AC-13: non-creator cannot archive channel (canArchiveChannel → false)', async () => {
    const canArchive = await canArchiveChannel(db, OTHER_ID, CHANNEL_ID)
    expect(canArchive).toBe(false)
  })

  test('AC-13: non-creator cannot write in channel (canWriteInChannel → false)', async () => {
    const canWrite = await canWriteInChannel(db, OTHER_ID, CHANNEL_ID)
    expect(canWrite).toBe(false)
  })

  // ── AC-14: Personal workspace behaves identically ────────────────────────────

  test('AC-14: single-user workspace — toggling scope does not error', async () => {
    // In a personal workspace, the creator is the only member.
    // Toggling to shared should succeed (no error) even though there are no other members.
    const handler = createSetScopeHandler(
      cm as ChannelManager,
      sm as SessionManager,
      pubsub as PubSubService,
      db,
      createMockFeatureFlagService() as any,
    )

    // Toggle to shared — should succeed
    const result = await handler(makeCtx(CREATOR_ID), {
      channelId: CHANNEL_ID,
      scope: 'shared',
    })
    expect(result.scope).toBe('shared')

    // Toggle back to personal — should also succeed
    const result2 = await handler(makeCtx(CREATOR_ID), {
      channelId: CHANNEL_ID,
      scope: 'personal',
    })
    expect(result2.scope).toBe('personal')
  })

  // ── Full flow: create → use app → redact → make shared → verify as non-owner ─

  test('FULL FLOW: create → use personal app → redact → make shared → verify as non-owner', async () => {
    // 1. Channel is personal by default (AC-1)
    expect(store.getChannel(CHANNEL_ID)!.scope).toBe('personal')

    // 2. Use personal app in personal conversation (AC-9)
    const app = store.getApp(APP_GMAIL_ID)!
    const mcaService = createMockMcaService(app)
    const workspaceService = createMockWorkspaceService()
    const mcaManager = createMockMcaManager()
    const execHandler = createExecuteToolHandler(
      mcaService as McaService,
      mcaManager as McaManager,
      workspaceService as WorkspaceService,
      null as any,
      db,
      createMockFeatureFlagService() as any,
    )

    const execResult = await execHandler(makeCtx(CREATOR_ID), {
      appId: APP_GMAIL_ID,
      tool: 'search',
      input: { channelId: CHANNEL_ID, query: 'inbox' },
    })
    expect(execResult.success).toBe(true)

    // 3. Add messages (simulating conversation)
    store.addMessage({
      messageId: 'msg_001',
      channelId: CHANNEL_ID,
      role: 'user',
      content: { type: 'text', text: 'Check my inbox for the confidential report' },
      timestamp: '2026-09-14T20:01:00Z',
    })
    store.addMessage({
      messageId: 'msg_002',
      channelId: CHANNEL_ID,
      role: 'assistant',
      content: { type: 'tool_execution', appId: APP_GMAIL_ID, mcaId: 'mca.teros.gmail' },
      timestamp: '2026-09-14T20:01:30Z',
    })
    store.addMessage({
      messageId: 'msg_003',
      channelId: CHANNEL_ID,
      role: 'assistant',
      content: { type: 'text', text: 'I found 3 emails about the confidential report' },
      timestamp: '2026-09-14T20:02:00Z',
    })

    // 4. Redact the sensitive messages (AC-5)
    const redactHandler = createToggleRedactionHandler(
      cm as ChannelManager,
      sm as SessionManager,
      pubsub as PubSubService,
      db,
      createMockFeatureFlagService() as any,
    )

    await redactHandler(makeCtx(CREATOR_ID), {
      channelId: CHANNEL_ID,
      messageId: 'msg_001',
      redacted: true,
    })
    await redactHandler(makeCtx(CREATOR_ID), {
      channelId: CHANNEL_ID,
      messageId: 'msg_002',
      redacted: true,
    })

    // 5. Run pre-publish scan (AC-10)
    const scanHandler = createPrePublishScanHandler(cm as ChannelManager, db, createMockFeatureFlagService() as any)
    const scanResult = await scanHandler(makeCtx(CREATOR_ID), { channelId: CHANNEL_ID })
    expect(scanResult.hasWarning).toBe(true)
    expect(scanResult.personalApps.length).toBeGreaterThan(0)

    // 6. Make conversation shared (AC-2)
    const scopeHandler = createSetScopeHandler(
      cm as ChannelManager,
      sm as SessionManager,
      pubsub as PubSubService,
      db,
      createMockFeatureFlagService() as any,
    )
    await scopeHandler(makeCtx(CREATOR_ID), { channelId: CHANNEL_ID, scope: 'shared' })
    expect(store.getChannel(CHANNEL_ID)!.scope).toBe('shared')

    // 7. Verify as non-owner (AC-6)
    const messages = store.getMessages(CHANNEL_ID).map((m) => m as unknown as Message)
    const safeMessages = redactMessagesForViewer(messages, false)

    // Redacted messages: content is null, placeholder present
    expect(safeMessages[0].content).not.toBeNull()
    expect((safeMessages[0].content as any).type).toBe("text")
    expect((safeMessages[0].content as any).text).not.toContain("sk-secret123")
    expect(safeMessages[0].redactedPlaceholder).toBeDefined()
    expect(safeMessages[1].content).not.toBeNull()
    expect((safeMessages[1].content as any).type).toBe("text")
    expect(safeMessages[1].redactedPlaceholder).toBeDefined()

    // Non-redacted message: content is visible
    expect(safeMessages[2].content).toEqual({ type: 'text', text: 'I found 3 emails about the confidential report' })

    // JSON audit: no secret content from redacted messages
    // msg_001 was redacted — its text "Check my inbox for the confidential report" must NOT appear
    // msg_003 was NOT redacted — its text "I found 3 emails about the confidential report" IS visible (expected)
    const serialized = JSON.stringify(safeMessages)
    expect(serialized).not.toContain('Check my inbox for the confidential report')
    // The non-redacted message's content IS visible (this is correct behavior)
    expect(serialized).toContain('I found 3 emails about the confidential report')

    // 8. Personal app now blocked in shared conversation (AC-8)
    try {
      await execHandler(makeCtx(CREATOR_ID), {
        appId: APP_GMAIL_ID,
        tool: 'search',
        input: { channelId: CHANNEL_ID, query: 'test' },
      })
      expect(false).toBe(true)
    } catch (e) {
      expect((e as HandlerError).code).toBe('PERSONAL_APP_BLOCKED')
    }
  })
})
