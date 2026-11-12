/**
 * MUW-F1 Integration test — redaction propagation from channel_messages to session_messages.
 *
 * This test exercises the REAL flow that the unit tests mocked away:
 * 1. toggleMessageRedaction() writes `redacted: true` to channel_messages
 * 2. toggleMessageRedaction() ALSO propagates `info.redacted: true` to session_messages
 *    via the `channelMessageId` cross-reference and `turnId` (whole-turn flagging)
 * 3. getMessagesForLLM(channelId, nonOwnerUserId) filters the redacted content
 * 4. getMessagesForLLM(channelId, ownerUserId) returns full content
 *
 * CRITICAL: The assistant-message case uses REALISTIC mismatched IDs —
 * channel_messages.messageId = msg_* (from channelManager.createMessageId())
 * session_messages.info.id = message_* (from generateAscendingID('message'))
 * These IDs do NOT match. The linkage is via info.channelMessageId.
 *
 * CRITICAL: The multi-bubble turn case tests redacting a TOOL bubble (#2 of 3)
 * where the tool bubble has a DIFFERENT channel messageId from the turn seed.
 * The turnId links all bubbles of the turn — redacting any bubble flags the
 * whole turn in session_messages (over-redaction = safe direction).
 *
 * Uses MONGODB_URI (default local :27017) with a unique db name that is dropped
 * afterwards. Skips silently if Mongo is down.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type Db, MongoClient, ObjectId } from 'mongodb'
import { MongoSessionStore } from './MongoSessionStore'
import { ChannelManager } from '../services/channel-manager'
import { RandomIdGenerator } from '@teros/core'
import type { ProviderService } from '../services/provider-service'

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017'
const DB_NAME = `teros_test_redaction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const SECRET_USER_CONTENT = 'My API key is sk-abc123 and the password is hunter2'
const SECRET_ASSISTANT_CONTENT = 'Based on your message, the API key sk-abc123 and password hunter2 are stored securely'

// Multi-bubble turn secrets
const TURN_SEED_ID = 'msg_turn_seed_' + Date.now()
const TURN_TEXT1_CONTENT = 'Let me search for that information.'
const TURN_TOOL_CONTENT = 'Tool result: the secret API key is sk-abc123 and password is hunter2'
const TURN_TEXT2_CONTENT = 'I found the API key sk-abc123 and password hunter2 in the tool results.'

describe('MUW-F1 integration: toggleMessageRedaction → getMessagesForLLM', () => {
  let mongoClient: MongoClient
  let db: Db
  let sessionStore: MongoSessionStore
  let channelManager: ChannelManager
  let available = false

  const channelId = 'ch_test_muw_f1_' + Date.now()
  const ownerUserId = 'user_owner_muw_f1'
  const nonOwnerUserId = 'user_nonowner_muw_f1'

  // User message: IDs match (channel_messages.messageId === session_messages.info.id)
  const userChannelMsgId = 'msg_user_' + Date.now()
  const userSessionMsgId = userChannelMsgId // same ID — normal user flow

  // Single assistant message: IDs DO NOT match (the realistic case)
  const assistantChannelMsgId = 'msg_asst_' + Date.now()
  const assistantSessionMsgId = 'message_' + Date.now() + '_abc123' // different namespace

  // Multi-bubble turn: 3 channel messages (text → tool → text), all sharing turnId
  // Bubble 1 (text): gets the seed as its messageId (pendingSeedId consumed)
  const turnBubble1ChannelId = TURN_SEED_ID
  // Bubble 2 (tool): gets a FRESH msg_* ID (seed already consumed)
  const turnBubble2ChannelId = 'msg_turn_tool_' + Date.now()
  // Bubble 3 (text): also gets a FRESH msg_* ID
  const turnBubble3ChannelId = 'msg_turn_text2_' + Date.now()
  // Session-side: all 3 steps share the same session message with channelMessageId = TURN_SEED_ID
  // (MessageProcessor stamps channelMessageId = seedId on every step)
  const turnSessionMsgId = 'message_turn_' + Date.now() + '_xyz789'

  beforeAll(async () => {
    try {
      mongoClient = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
      db = mongoClient.db(DB_NAME)
      available = true
    } catch {
      console.warn('[redaction integration test] Mongo unreachable — skipping')
      return
    }

    sessionStore = new MongoSessionStore(db)
    // The store creates its indexes fire-and-forget in the constructor; wait
    // for the last one (sessions) so afterAll's dropDatabase/close does not
    // interrupt the build on the fresh throwaway db.
    for (let i = 0; i < 50; i++) {
      const names = await db.collection('sessions').indexes().then((ix) => ix.map((x) => x.name), () => [])
      if (names.includes('userId_1_time.updated_-1')) break
      await new Promise((r) => setTimeout(r, 20))
    }
    channelManager = new ChannelManager(db, {} as ProviderService, new RandomIdGenerator())

    await db.collection('sessions').insertOne({
      id: channelId,
      userId: ownerUserId,
      time: { created: Date.now(), updated: Date.now() },
    })

    // ── User message: matching IDs ──
    await db.collection('channel_messages').insertOne({
      messageId: userChannelMsgId,
      channelId,
      role: 'user',
      content: { type: 'text', text: SECRET_USER_CONTENT },
      timestamp: new Date().toISOString(),
    })

    await db.collection('session_messages').insertOne({
      _id: new ObjectId(),
      sessionId: channelId,
      info: {
        id: userSessionMsgId,
        sessionID: channelId,
        role: 'user',
        time: { created: Date.now() },
        channelMessageId: userChannelMsgId,
      },
      parts: [{
        id: 'part_user_' + Date.now(),
        sessionID: channelId,
        messageID: userSessionMsgId,
        type: 'text',
        text: SECRET_USER_CONTENT,
        time: { start: Date.now(), end: Date.now() },
      }],
    })

    // ── Single assistant message: mismatched IDs ──
    await db.collection('channel_messages').insertOne({
      messageId: assistantChannelMsgId,
      channelId,
      role: 'assistant',
      agentId: 'agent_test',
      content: { type: 'text', text: SECRET_ASSISTANT_CONTENT },
      timestamp: new Date().toISOString(),
      turnId: assistantChannelMsgId, // single-bubble turn: turnId = own messageId
    })

    await db.collection('session_messages').insertOne({
      _id: new ObjectId(),
      sessionId: channelId,
      info: {
        id: assistantSessionMsgId,
        sessionID: channelId,
        role: 'assistant',
        time: { created: Date.now() },
        channelMessageId: assistantChannelMsgId,
      },
      parts: [{
        id: 'part_asst_' + Date.now(),
        sessionID: channelId,
        messageID: assistantSessionMsgId,
        type: 'text',
        text: SECRET_ASSISTANT_CONTENT,
        time: { start: Date.now(), end: Date.now() },
      }],
    })

    // ── Multi-bubble turn: text → tool → text ──
    // All 3 channel messages share turnId = TURN_SEED_ID
    // Bubble 1 (text): messageId = seed (pendingSeedId consumed here)
    await db.collection('channel_messages').insertOne({
      messageId: turnBubble1ChannelId,
      channelId,
      role: 'assistant',
      agentId: 'agent_test',
      content: { type: 'text', text: TURN_TEXT1_CONTENT },
      timestamp: new Date().toISOString(),
      turnId: TURN_SEED_ID,
    })

    // Bubble 2 (tool): fresh msg_* ID, but same turnId
    await db.collection('channel_messages').insertOne({
      messageId: turnBubble2ChannelId,
      channelId,
      role: 'assistant',
      agentId: 'agent_test',
      content: { type: 'tool_execution', toolCallId: 'call_1', toolName: 'search', status: 'completed', result: TURN_TOOL_CONTENT },
      timestamp: new Date().toISOString(),
      turnId: TURN_SEED_ID,
    })

    // Bubble 3 (text after tool): fresh msg_* ID, but same turnId
    await db.collection('channel_messages').insertOne({
      messageId: turnBubble3ChannelId,
      channelId,
      role: 'assistant',
      agentId: 'agent_test',
      content: { type: 'text', text: TURN_TEXT2_CONTENT },
      timestamp: new Date().toISOString(),
      turnId: TURN_SEED_ID,
    })

    // Session-side: single session message for the whole turn, channelMessageId = seed
    // (MessageProcessor stamps channelMessageId = seedId on every step)
    await db.collection('session_messages').insertOne({
      _id: new ObjectId(),
      sessionId: channelId,
      info: {
        id: turnSessionMsgId,
        sessionID: channelId,
        role: 'assistant',
        time: { created: Date.now() },
        channelMessageId: TURN_SEED_ID, // links to the turn seed, NOT to individual bubble IDs
      },
      parts: [{
        id: 'part_turn_' + Date.now(),
        sessionID: channelId,
        messageID: turnSessionMsgId,
        type: 'text',
        text: TURN_TEXT1_CONTENT + ' ' + TURN_TOOL_CONTENT + ' ' + TURN_TEXT2_CONTENT,
        time: { start: Date.now(), end: Date.now() },
      }],
    })
  })

  afterAll(async () => {
    if (!available) return
    await db.dropDatabase()
    await mongoClient.close()
  })

  // ── User message: matching IDs (legacy path) ──

  test('before redaction: non-owner sees user content in LLM context', async () => {
    if (!available) return
    const { messages } = await sessionStore.getMessagesForLLM(channelId, nonOwnerUserId)
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain(SECRET_USER_CONTENT)
  })

  test('redact user message (matching IDs): flag propagates to session_messages', async () => {
    if (!available) return
    await channelManager.toggleMessageRedaction(channelId, userChannelMsgId, true, ownerUserId)
    const sessionMsg = await db.collection('session_messages').findOne({ sessionId: channelId, 'info.id': userSessionMsgId })
    expect(sessionMsg?.info?.redacted).toBe(true)
  })

  test('after user redaction: non-owner LLM context does NOT contain user secret', async () => {
    if (!available) return
    const { messages } = await sessionStore.getMessagesForLLM(channelId, nonOwnerUserId)
    const serialized = JSON.stringify(messages)
    expect(serialized).not.toContain(SECRET_USER_CONTENT)
    expect(serialized).toContain('[Content redacted by the channel owner]')
  })

  test('after user redaction: owner still sees user content', async () => {
    if (!available) return
    const { messages } = await sessionStore.getMessagesForLLM(channelId, ownerUserId)
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain(SECRET_USER_CONTENT)
  })

  test('after user redaction: no viewerId (internal callers) sees full content', async () => {
    if (!available) return
    const { messages } = await sessionStore.getMessagesForLLM(channelId)
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain(SECRET_USER_CONTENT)
  })

  // ── Single assistant message: mismatched IDs ──

  test('redact assistant message (mismatched IDs): flag propagates via channelMessageId', async () => {
    if (!available) return
    await channelManager.toggleMessageRedaction(channelId, assistantChannelMsgId, true, ownerUserId)
    const sessionMsg = await db.collection('session_messages').findOne({ sessionId: channelId, 'info.id': assistantSessionMsgId })
    expect(sessionMsg?.info?.redacted).toBe(true)
  })

  test('after assistant redaction: non-owner LLM context does NOT contain assistant secret', async () => {
    if (!available) return
    const { messages } = await sessionStore.getMessagesForLLM(channelId, nonOwnerUserId)
    const serialized = JSON.stringify(messages)
    expect(serialized).not.toContain(SECRET_ASSISTANT_CONTENT)
  })

  test('after assistant redaction: owner still sees assistant content', async () => {
    if (!available) return
    const { messages } = await sessionStore.getMessagesForLLM(channelId, ownerUserId)
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain(SECRET_ASSISTANT_CONTENT)
  })

  // ── Multi-bubble turn: redact the TOOL bubble (#2) — the critical case ──

  test('redact TOOL bubble (#2 of 3, fresh msg_* ID): flag propagates to turn session docs via turnId', async () => {
    if (!available) return
    // This is the test that would have caught the 3rd-review gap:
    // - Tool bubble has messageId = msg_turn_tool_* (NOT the seed)
    // - Session doc has channelMessageId = TURN_SEED_ID (the seed, not the tool bubble's ID)
    // - Only linkage: channel_messages.turnId = TURN_SEED_ID → session_messages.info.channelMessageId === TURN_SEED_ID
    await channelManager.toggleMessageRedaction(channelId, turnBubble2ChannelId, true, ownerUserId)

    const sessionMsg = await db.collection('session_messages').findOne({ sessionId: channelId, 'info.id': turnSessionMsgId })
    expect(sessionMsg?.info?.redacted).toBe(true)
  })

  test('after tool bubble redaction: non-owner LLM context does NOT contain turn secrets', async () => {
    if (!available) return
    const { messages } = await sessionStore.getMessagesForLLM(channelId, nonOwnerUserId)
    const serialized = JSON.stringify(messages)

    // All content from the turn must be filtered (whole-turn flagging)
    expect(serialized).not.toContain(TURN_TEXT1_CONTENT)
    expect(serialized).not.toContain(TURN_TOOL_CONTENT)
    expect(serialized).not.toContain(TURN_TEXT2_CONTENT)
    expect(serialized).not.toContain('sk-abc123')
    expect(serialized).not.toContain('hunter2')
  })

  test('after tool bubble redaction: owner still sees turn content', async () => {
    if (!available) return
    const { messages } = await sessionStore.getMessagesForLLM(channelId, ownerUserId)
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain(TURN_TEXT1_CONTENT)
    expect(serialized).toContain(TURN_TOOL_CONTENT)
    expect(serialized).toContain(TURN_TEXT2_CONTENT)
  })

  test('after tool bubble redaction: no viewerId (internal callers) sees full content', async () => {
    if (!available) return
    const { messages } = await sessionStore.getMessagesForLLM(channelId)
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain(TURN_TEXT1_CONTENT)
    expect(serialized).toContain(TURN_TOOL_CONTENT)
  })

  // ── Un-redact symmetry ──

  test('un-redact user message: flag cleared', async () => {
    if (!available) return
    await channelManager.toggleMessageRedaction(channelId, userChannelMsgId, false, ownerUserId)
    const sessionMsg = await db.collection('session_messages').findOne({ sessionId: channelId, 'info.id': userSessionMsgId })
    expect(sessionMsg?.info?.redacted).toBe(false)
  })

  test('un-redact assistant message: flag cleared', async () => {
    if (!available) return
    await channelManager.toggleMessageRedaction(channelId, assistantChannelMsgId, false, ownerUserId)
    const sessionMsg = await db.collection('session_messages').findOne({ sessionId: channelId, 'info.id': assistantSessionMsgId })
    expect(sessionMsg?.info?.redacted).toBe(false)
  })

  test('un-redact tool bubble: flag cleared via turnId', async () => {
    if (!available) return
    await channelManager.toggleMessageRedaction(channelId, turnBubble2ChannelId, false, ownerUserId)
    const sessionMsg = await db.collection('session_messages').findOne({ sessionId: channelId, 'info.id': turnSessionMsgId })
    expect(sessionMsg?.info?.redacted).toBe(false)
  })

  test('after un-redact all: non-owner sees all content again', async () => {
    if (!available) return
    const { messages } = await sessionStore.getMessagesForLLM(channelId, nonOwnerUserId)
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain(SECRET_USER_CONTENT)
    expect(serialized).toContain(SECRET_ASSISTANT_CONTENT)
    expect(serialized).toContain(TURN_TEXT1_CONTENT)
  })
})
