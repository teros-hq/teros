/**
 * Redaction Sweep — value-based redaction primitive integration test
 * (docs/specs/20261031_agent-secret-tools.md, designs A + D).
 *
 * Exercises the REAL flow against local MongoDB (pattern of
 * redaction-integration.test.ts — unique db name, dropped afterwards,
 * skips silently if Mongo is down):
 *
 * AC 2 (Pablo's SSH example): a secret surfaces in THREE places —
 *   (a) an SSH tool output (channel tool_execution content + session tool part),
 *   (b) an agent echo (text message),
 *   (c) the set-app-secret/redact-by-value call's own arguments (tool input).
 * After ONE sweep, ALL THREE are redacted — and the next agent turn
 * (getMessagesForLLM with viewerKind 'agent') sees `[redacted: <mask>]`
 * placeholders, never plaintext.
 *
 * AC 3: the sweep is self-redacting — the call's own message is swept.
 * AC 8: alsoRedact covers a message the exact match missed (split key).
 * AC 4: un-redact (toggleMessageRedaction false) restores visibility.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type Db, MongoClient, ObjectId } from 'mongodb'
import { ChannelManager } from './channel-manager'
import { sweepRedactByValue } from './redaction-sweep'
import { MongoSessionStore } from '../session/MongoSessionStore'
import { RandomIdGenerator } from '@teros/core'
import type { ProviderService } from './provider-service'

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017'
const DB_NAME = `teros_test_sweep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

// The secret Pablo's example: an SSH tool output leaks the provider API key.
const SECRET = 'sk_live_51AbCdEfGhIjKlMn4f2a'
const SECRET_MASK = 'sk_live_…4f2a'

describe('Agent secret tools: sweepRedactByValue', () => {
  let mongoClient: MongoClient
  let db: Db
  let channelManager: ChannelManager
  let sessionStore: MongoSessionStore
  let available = false

  const channelId = 'ch_test_sweep_' + Date.now()
  const ownerUserId = 'user_owner_sweep'
  const agentId = 'agent_sweeper'

  // Surface (a): SSH tool output — channel tool_execution + session tool part
  const sshChannelMsgId = 'msg_ssh_' + Date.now()
  const sshSessionMsgId = 'message_ssh_' + Date.now()
  // Surface (b): agent echo — plain text
  const echoChannelMsgId = 'msg_echo_' + Date.now()
  const echoSessionMsgId = echoChannelMsgId
  // Surface (c): the sweep call itself — tool input carrying the value
  const callChannelMsgId = 'msg_call_' + Date.now()
  const callSessionMsgId = 'message_call_' + Date.now()
  // Control: a clean message with no secret
  const cleanChannelMsgId = 'msg_clean_' + Date.now()
  // AC 8: split-key message (exact match misses it)
  const splitChannelMsgId = 'msg_split_' + Date.now()
  const splitSessionMsgId = 'message_split_' + Date.now()

  beforeAll(async () => {
    try {
      mongoClient = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 3000 })
      db = mongoClient.db(DB_NAME)
      available = true
    } catch {
      console.warn('[redaction sweep test] Mongo unreachable — skipping')
      return
    }

    sessionStore = new MongoSessionStore(db)
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

    // (a) SSH tool output carrying the secret
    await db.collection('channel_messages').insertOne({
      messageId: sshChannelMsgId,
      channelId,
      role: 'assistant',
      agentId,
      content: {
        type: 'tool_execution',
        toolCallId: 'call_ssh_1',
        toolName: 'remote.ssh',
        status: 'completed',
        input: { command: 'cat /etc/provider/key' },
        output: `# /etc/provider/key\nAPI_KEY=${SECRET}\n`,
      },
      timestamp: new Date().toISOString(),
      turnId: sshChannelMsgId,
    })
    await db.collection('session_messages').insertOne({
      _id: new ObjectId(),
      sessionId: channelId,
      info: {
        id: sshSessionMsgId,
        sessionID: channelId,
        role: 'assistant',
        time: { created: Date.now() },
        channelMessageId: sshChannelMsgId,
      },
      parts: [{
        id: 'part_ssh_' + Date.now(),
        sessionID: channelId,
        messageID: sshSessionMsgId,
        type: 'tool',
        tool: 'remote.ssh',
        callID: 'call_ssh_1',
        state: {
          status: 'completed',
          input: { command: 'cat /etc/provider/key' },
          output: `API_KEY=${SECRET}`,
          title: '',
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      }],
    })

    // (b) Agent echo repeating the secret
    await db.collection('channel_messages').insertOne({
      messageId: echoChannelMsgId,
      channelId,
      role: 'assistant',
      agentId,
      content: { type: 'text', text: `Ya la tengo: ${SECRET} — la guardo ahora.` },
      timestamp: new Date().toISOString(),
      turnId: echoChannelMsgId,
    })
    await db.collection('session_messages').insertOne({
      _id: new ObjectId(),
      sessionId: channelId,
      info: {
        id: echoSessionMsgId,
        sessionID: channelId,
        role: 'assistant',
        time: { created: Date.now() },
        channelMessageId: echoChannelMsgId,
      },
      parts: [{
        id: 'part_echo_' + Date.now(),
        sessionID: channelId,
        messageID: echoSessionMsgId,
        type: 'text',
        text: `Ya la tengo: ${SECRET} — la guardo ahora.`,
        time: { start: Date.now(), end: Date.now() },
      }],
    })

    // (c) The sweep/set-app-secret call itself — arguments carry the value
    await db.collection('channel_messages').insertOne({
      messageId: callChannelMsgId,
      channelId,
      role: 'assistant',
      agentId,
      content: {
        type: 'tool_execution',
        toolCallId: 'call_set_1',
        toolName: 'core.set-app-secret',
        status: 'completed',
        input: { appId: 'app_make', key: 'MAKE_API_TOKEN', value: SECRET },
        output: 'success',
      },
      timestamp: new Date().toISOString(),
      turnId: callChannelMsgId,
    })
    await db.collection('session_messages').insertOne({
      _id: new ObjectId(),
      sessionId: channelId,
      info: {
        id: callSessionMsgId,
        sessionID: channelId,
        role: 'assistant',
        time: { created: Date.now() },
        channelMessageId: callChannelMsgId,
      },
      parts: [{
        id: 'part_call_' + Date.now(),
        sessionID: channelId,
        messageID: callSessionMsgId,
        type: 'tool',
        tool: 'core.set-app-secret',
        callID: 'call_set_1',
        state: {
          status: 'completed',
          input: { appId: 'app_make', key: 'MAKE_API_TOKEN', value: SECRET },
          output: 'success',
          title: '',
          metadata: {},
          time: { start: Date.now(), end: Date.now() },
        },
      }],
    })

    // Control: clean message
    await db.collection('channel_messages').insertOne({
      messageId: cleanChannelMsgId,
      channelId,
      role: 'user',
      content: { type: 'text', text: 'configura la app de Make por favor' },
      timestamp: new Date().toISOString(),
    })

    // AC 8: split key — the value broken across lines, exact match misses it
    await db.collection('channel_messages').insertOne({
      messageId: splitChannelMsgId,
      channelId,
      role: 'user',
      content: { type: 'text', text: 'la key es sk_live_51AbCdEfGh\nIjKlMn4f2a ( partida en dos líneas )' },
      timestamp: new Date().toISOString(),
    })
    await db.collection('session_messages').insertOne({
      _id: new ObjectId(),
      sessionId: channelId,
      info: {
        id: splitSessionMsgId,
        sessionID: channelId,
        role: 'user',
        time: { created: Date.now() },
        channelMessageId: splitChannelMsgId,
      },
      parts: [{
        id: 'part_split_' + Date.now(),
        sessionID: channelId,
        messageID: splitSessionMsgId,
        type: 'text',
        text: 'la key es sk_live_51AbCdEfGh\nIjKlMn4f2a ( partida en dos líneas )',
        time: { start: Date.now(), end: Date.now() },
      }],
    })
  })

  afterAll(async () => {
    if (available) {
      await db.dropDatabase().catch(() => {})
      await mongoClient.close().catch(() => {})
    }
  })

  test('AC 2 + AC 3: one sweep redacts all three surfaces — SSH output, agent echo, and the call itself', async () => {
    if (!available) return

    const result = await sweepRedactByValue(db, channelManager, channelId, SECRET, {
      redactedBy: agentId,
    })

    // Coverage report: ids only, never the value
    expect(result.redactedCount).toBe(3)
    expect(result.messageIds).toContain(sshChannelMsgId)
    expect(result.messageIds).toContain(echoChannelMsgId)
    expect(result.messageIds).toContain(callChannelMsgId) // self-redacting
    expect(result.messageIds).not.toContain(cleanChannelMsgId) // control untouched
    expect(JSON.stringify(result)).not.toContain(SECRET)

    // Per-surface stats: SSH output (toolOutput), echo (text), call (toolInput)
    expect(result.surfaces.toolOutput).toBeGreaterThanOrEqual(1)
    expect(result.surfaces.text).toBeGreaterThanOrEqual(1)
    expect(result.surfaces.toolInput).toBeGreaterThanOrEqual(1)

    // channel_messages: all three flagged
    for (const id of [sshChannelMsgId, echoChannelMsgId, callChannelMsgId]) {
      const msg = await db.collection('channel_messages').findOne({ channelId, messageId: id })
      expect(msg?.redacted).toBe(true)
      expect(msg?.redactedBy).toBe(agentId)
    }
    const clean = await db.collection('channel_messages').findOne({ channelId, messageId: cleanChannelMsgId })
    expect(clean?.redacted).toBeFalsy()
  })

  test('AC 2 (agent view): next agent turn sees [redacted: mask] placeholders, never plaintext', async () => {
    if (!available) return

    // The LLM context build: viewerId = channel owner, viewerKind = 'agent'
    const { messages } = await sessionStore.getMessagesForLLM(channelId, ownerUserId, {
      viewerKind: 'agent',
    })

    const json = JSON.stringify(messages)
    // Never the plaintext
    expect(json).not.toContain(SECRET)
    // The mask placeholder appears (from the tool part with the secret-ish key)
    expect(json).toContain('[redacted: ' + SECRET_MASK + ']')
    // Placeholders are synthetic text parts
    const placeholders = messages.flatMap((m) => m.parts).filter(
      (p: any) => p.type === 'text' && p.metadata?.redactedPlaceholder,
    )
    expect(placeholders.length).toBeGreaterThanOrEqual(3)
  })

  test('AC 2 (owner view): human owner still sees full content — UX unchanged', async () => {
    if (!available) return

    const { messages } = await sessionStore.getMessagesForLLM(channelId, ownerUserId)
    expect(JSON.stringify(messages)).toContain(SECRET)
  })

  test('AC 8: alsoRedact covers the split-key message the exact match missed', async () => {
    if (!available) return

    // Exact-match sweep alone misses the split key
    const first = await sweepRedactByValue(db, channelManager, channelId, SECRET, {
      redactedBy: agentId,
    })
    expect(first.messageIds).not.toContain(splitChannelMsgId)

    // The agent passes the missed id explicitly
    const second = await sweepRedactByValue(db, channelManager, channelId, SECRET, {
      alsoRedact: [splitChannelMsgId],
      redactedBy: agentId,
    })
    expect(second.alsoRedacted).toContain(splitChannelMsgId)
    expect(second.messageIds).toContain(splitChannelMsgId)

    const split = await db.collection('channel_messages').findOne({ channelId, messageId: splitChannelMsgId })
    expect(split?.redacted).toBe(true)
  })

  test('AC 4: owner un-redact restores full agent visibility', async () => {
    if (!available) return

    await channelManager.toggleMessageRedaction(channelId, sshChannelMsgId, false, ownerUserId)

    const { messages } = await sessionStore.getMessagesForLLM(channelId, ownerUserId, {
      viewerKind: 'agent',
    })
    // The un-redacted message is fully visible to the agent again
    const json = JSON.stringify(messages)
    expect(json).toContain(SECRET)
  })

  test('guards: rejects too-short values and missing channel', async () => {
    if (!available) return

    await expect(
      sweepRedactByValue(db, channelManager, channelId, 'abc', { redactedBy: agentId }),
    ).rejects.toThrow(/too short/i)
    await expect(
      sweepRedactByValue(db, channelManager, '', SECRET, { redactedBy: agentId }),
    ).rejects.toThrow(/channelId/i)
  })
})
