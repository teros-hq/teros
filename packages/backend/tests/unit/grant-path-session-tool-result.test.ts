/**
 * Grant path v4 (2026-10-27): the approved tool's result must reach the
 * agent's context — the session-store tool part is rewritten with the real
 * output before the wake.
 *
 * The chain under test (MessageHandler.executeRestoredTool →
 * updateSessionToolPartResult):
 *
 *   original turn  → tool part completed with the 'permission_requested'
 *                    marker as output (McaToolExecutor's endsTurn cut)
 *   user approves  → handleResponse fires executeRestoredTool (grant path)
 *   tool runs      → result written to channel_messages + broadcast (UI) ✅
 *                    but the session store still shows the marker ❌ (the bug)
 *   THIS FIX       → the session tool part (matched by callID) is rewritten
 *                    to ToolStateCompleted/ToolStateError with the real
 *                    output, so the wake turn's history shows the result the
 *                    wake text promises ("continue based on the result").
 *
 * Strategy: invoke MessageHandler.prototype.updateSessionToolPartResult.call(
 * stub, …) with a minimal `this` carrying only a fake sessionStore — same
 * pattern as handle-stop-message.test.ts (no mock.module leaks).
 */

import { describe, expect, it } from 'bun:test'
import { MessageHandler } from '../../src/handlers/message-handler'

const CHANNEL = 'ch_grant_test'
const TOOL_CALL_ID = 'toolu_tc_grant_1'

type WrittenPart = Record<string, any>

function makeSessionStore(messages: Array<{ info: any; parts: any[] }>) {
  const written: WrittenPart[] = []
  return {
    written,
    store: {
      getMessagesForLLM: async (sessionId: string) => {
        expect(sessionId).toBe(CHANNEL)
        return { summary: undefined, messages }
      },
      writePart: async (part: any) => {
        written.push(part)
      },
    },
  }
}

function makeToolPart(overrides: Record<string, any> = {}) {
  return {
    id: 'part_grant_1',
    sessionID: CHANNEL,
    messageID: 'msg_assistant_1',
    type: 'tool',
    tool: 'todo_list_get-autoplay',
    callID: TOOL_CALL_ID,
    // The state the v4 cut leaves behind: completed with the MARKER as output.
    state: {
      status: 'completed',
      input: { nodeId: 'tn_1' },
      output: JSON.stringify({
        status: 'permission_requested',
        permissionRequestId: 'perm_1',
        tool: 'todo_list_get-autoplay',
        instruction: 'End your turn now — do not wait.',
      }),
      title: '',
      metadata: {},
      time: { start: 1000, end: 2000 },
    },
    ...overrides,
  }
}

function callRewrite(stub: any, args: Parameters<any> | any[]) {
  return (MessageHandler.prototype as any).updateSessionToolPartResult.call(
    stub,
    ...args,
  )
}

describe('MessageHandler.updateSessionToolPartResult — grant path v4', () => {
  it('rewrites the marker tool part with the real output (completed)', async () => {
    const messages = [
      { info: { id: 'msg_user_1', role: 'user' }, parts: [] },
      {
        info: { id: 'msg_assistant_1', role: 'assistant' },
        parts: [makeToolPart()],
      },
    ]
    const { store, written } = makeSessionStore(messages)
    const stub = { sessionStore: store }

    await callRewrite(stub, [
      CHANNEL,
      TOOL_CALL_ID,
      'todo_list_get-autoplay',
      { output: '{"runners":[]}', isError: false },
      150,
    ])

    expect(written).toHaveLength(1)
    const part = written[0]
    // Identity preserved — MongoSessionStore updates in place by (info.id, parts.id)
    expect(part.id).toBe('part_grant_1')
    expect(part.messageID).toBe('msg_assistant_1')
    expect(part.callID).toBe(TOOL_CALL_ID)
    // The REAL output replaced the marker
    expect(part.state.status).toBe('completed')
    expect(part.state.output).toBe('{"runners":[]}')
    expect(part.state.input).toEqual({ nodeId: 'tn_1' })
    // time.start preserved from the original part, end stamped now
    expect(part.state.time.start).toBe(1000)
    expect(part.state.time.end).toBeGreaterThan(2000)
  })

  it('rewrites to error state when the tool failed', async () => {
    const messages = [
      {
        info: { id: 'msg_assistant_1', role: 'assistant' },
        parts: [makeToolPart()],
      },
    ]
    const { store, written } = makeSessionStore(messages)
    const stub = { sessionStore: store }

    await callRewrite(stub, [
      CHANNEL,
      TOOL_CALL_ID,
      'todo_list_get-autoplay',
      { output: 'Error: connection refused', isError: true },
      50,
    ])

    expect(written).toHaveLength(1)
    const part = written[0]
    expect(part.state.status).toBe('error')
    expect(part.state.error).toBe('Error: connection refused')
    expect(part.state.input).toEqual({ nodeId: 'tn_1' })
  })

  it('maps attachments to FileParts on the completed state', async () => {
    const messages = [
      {
        info: { id: 'msg_assistant_1', role: 'assistant' },
        parts: [makeToolPart()],
      },
    ]
    const { store, written } = makeSessionStore(messages)
    const stub = { sessionStore: store }

    await callRewrite(stub, [
      CHANNEL,
      TOOL_CALL_ID,
      'messaging_send-file',
      {
        output: 'sent',
        isError: false,
        attachments: [{ url: 'https://x/file.png', mime: 'image/png', filename: 'file.png' }],
      },
      120,
    ])

    expect(written).toHaveLength(1)
    const part = written[0]
    expect(part.state.status).toBe('completed')
    expect(part.state.attachments).toHaveLength(1)
    expect(part.state.attachments[0]).toMatchObject({
      type: 'file',
      mime: 'image/png',
      url: 'https://x/file.png',
      filename: 'file.png',
      sessionID: CHANNEL,
      messageID: 'msg_assistant_1',
    })
  })

  it('searches BACKWARDS — a stale older part with the same callID never wins', async () => {
    const stalePart = makeToolPart({
      id: 'part_stale',
      messageID: 'msg_assistant_old',
      state: { status: 'completed', input: {}, output: 'stale', time: { start: 1, end: 2 } },
    })
    const freshPart = makeToolPart({ id: 'part_fresh', messageID: 'msg_assistant_new' })
    const messages = [
      { info: { id: 'msg_user_1', role: 'user' }, parts: [] },
      { info: { id: 'msg_assistant_old', role: 'assistant' }, parts: [stalePart] },
      { info: { id: 'msg_user_2', role: 'user' }, parts: [] },
      { info: { id: 'msg_assistant_new', role: 'assistant' }, parts: [freshPart] },
    ]
    const { store, written } = makeSessionStore(messages)
    const stub = { sessionStore: store }

    await callRewrite(stub, [
      CHANNEL,
      TOOL_CALL_ID,
      'todo_list_get-autoplay',
      { output: 'fresh result', isError: false },
      10,
    ])

    expect(written).toHaveLength(1)
    expect(written[0].id).toBe('part_fresh')
    expect(written[0].messageID).toBe('msg_assistant_new')
    expect(written[0].state.output).toBe('fresh result')
  })

  it('fail-safe: no matching part → nothing written, no throw (wake still runs)', async () => {
    const messages = [
      {
        info: { id: 'msg_assistant_1', role: 'assistant' },
        parts: [makeToolPart({ callID: 'toolu_OTHER' })],
      },
    ]
    const { store, written } = makeSessionStore(messages)
    const stub = { sessionStore: store }

    await expect(
      callRewrite(stub, [
        CHANNEL,
        TOOL_CALL_ID,
        'todo_list_get-autoplay',
        { output: 'x', isError: false },
        10,
      ]),
    ).resolves.toBeUndefined()
    expect(written).toHaveLength(0)
  })

  it('fail-safe: sessionStore.getMessagesForLLM throwing → no throw (wake still runs)', async () => {
    const store = {
      getMessagesForLLM: async () => {
        throw new Error('db down')
      },
      writePart: async () => {},
    }
    const stub = { sessionStore: store }

    await expect(
      callRewrite(stub, [
        CHANNEL,
        TOOL_CALL_ID,
        'todo_list_get-autoplay',
        { output: 'x', isError: false },
        10,
      ]),
    ).resolves.toBeUndefined()
  })

  it('fail-safe: no sessionStore at all → no throw', async () => {
    const stub = {}
    await expect(
      callRewrite(stub, [
        CHANNEL,
        TOOL_CALL_ID,
        'todo_list_get-autoplay',
        { output: 'x', isError: false },
        10,
      ]),
    ).resolves.toBeUndefined()
  })

  it('handles a marker part still in running state (defensive: pre-cut sessions)', async () => {
    const runningPart = makeToolPart({
      state: { status: 'running', input: { nodeId: 'tn_1' }, time: { start: 1000 } },
    })
    const messages = [
      { info: { id: 'msg_assistant_1', role: 'assistant' }, parts: [runningPart] },
    ]
    const { store, written } = makeSessionStore(messages)
    const stub = { sessionStore: store }

    await callRewrite(stub, [
      CHANNEL,
      TOOL_CALL_ID,
      'todo_list_get-autoplay',
      { output: 'ok', isError: false },
      10,
    ])

    expect(written).toHaveLength(1)
    expect(written[0].state.status).toBe('completed')
    expect(written[0].state.output).toBe('ok')
    expect(written[0].state.time.start).toBe(1000)
  })
})
