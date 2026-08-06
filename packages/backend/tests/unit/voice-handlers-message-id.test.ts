/**
 * Voice handlers + appendInterruptionNote tests (PR #113).
 *
 * Covers three pieces of MessageHandler not yet exercised by the suite:
 *
 *  1. `appendInterruptionNote(channelId)` (private) — synthetic note appended
 *     to the last assistant message after a user-initiated stop. Skips if no
 *     assistant message, if there are pending tool parts (running /
 *     pending_approval), or if the assistant has no text parts yet.
 *
 *  2. `processVoiceContent` (private) — when a voice note transcribes to a
 *     non-empty string, must call `processAgentResponse(_, _, _, messageId)`
 *     with the audio message's `messageId` so worker `queue_state` events
 *     resolve back to the same bubble (fix `f2d75cbf`).
 *
 *  3. `retryTranscription` — same propagation: when retry succeeds, call
 *     `processAgentResponse(_, _, _, messageId)` with the retried message's
 *     id (fix `f92f711e`).
 *
 * Strategy: invoke the private methods through
 * `(MessageHandler.prototype as any).METHOD.call(stub, ...)` with a minimal
 * `this` carrying only the fields the method touches — same pattern as
 * `handle-stop-message.test.ts`. Avoids the heavyweight constructor.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { MessageHandler } from '../../src/handlers/message-handler'

// ---------------------------------------------------------------------------
// Common fixtures
// ---------------------------------------------------------------------------

const CHANNEL_ID = 'ch_voice_test'
const AGENT_ID = 'agent_voice_test'
const MESSAGE_ID = 'msg_voice_audio'
const USER_ID = 'user_voice_caller' as any

function makeFakeWs() {
  const send = mock((_data: string) => {})
  return {
    send,
    readyState: 1,
    OPEN: 1,
  } as any
}

// ---------------------------------------------------------------------------
// 1) appendInterruptionNote
// ---------------------------------------------------------------------------

function makeAssistantMessage(parts: any[]) {
  return {
    info: { id: 'msg_assistant_1', role: 'assistant' as const },
    parts,
  }
}

function makeUserMessage() {
  return {
    info: { id: 'msg_user_1', role: 'user' as const },
    parts: [{ type: 'text', text: 'hola' }],
  }
}

function makeInterruptionStub(messages: any[]) {
  const writePart = mock(async (_part: any) => {})
  const getMessagesForLLM = mock(async (_channelId: string) => ({ messages }))
  const stub = {
    sessionStore: {
      getMessagesForLLM,
      writePart,
    },
  }
  return { stub, writePart, getMessagesForLLM }
}

function callAppendNote(stub: any, channelId: string = CHANNEL_ID) {
  return (MessageHandler.prototype as any).appendInterruptionNote.call(stub, channelId)
}

describe('MessageHandler.appendInterruptionNote', () => {
  it('no assistant message in history → no writePart', async () => {
    const { stub, writePart, getMessagesForLLM } = makeInterruptionStub([makeUserMessage()])

    await callAppendNote(stub)

    expect(getMessagesForLLM).toHaveBeenCalledTimes(1)
    expect(getMessagesForLLM.mock.calls[0][0]).toBe(CHANNEL_ID)
    expect(writePart).toHaveBeenCalledTimes(0)
  })

  it('last assistant has tool part with state.status="running" → skip (no writePart)', async () => {
    const assistant = makeAssistantMessage([
      { type: 'text', text: 'starting…' },
      { type: 'tool', state: { status: 'running' } },
    ])
    const { stub, writePart } = makeInterruptionStub([makeUserMessage(), assistant])

    await callAppendNote(stub)

    expect(writePart).toHaveBeenCalledTimes(0)
  })

  it('last assistant has tool part with state.status="pending_approval" → skip', async () => {
    const assistant = makeAssistantMessage([
      { type: 'text', text: 'about to…' },
      { type: 'tool', state: { status: 'pending_approval' } },
    ])
    const { stub, writePart } = makeInterruptionStub([assistant])

    await callAppendNote(stub)

    expect(writePart).toHaveBeenCalledTimes(0)
  })

  it('last assistant has no parts → skip (silence is the signal)', async () => {
    const assistant = makeAssistantMessage([])
    const { stub, writePart } = makeInterruptionStub([assistant])

    await callAppendNote(stub)

    expect(writePart).toHaveBeenCalledTimes(0)
  })

  it('last assistant has only text → writes synthetic interruption note', async () => {
    const assistant = makeAssistantMessage([
      { type: 'text', text: 'estoy pensando' },
    ])
    const { stub, writePart } = makeInterruptionStub([assistant])

    await callAppendNote(stub)

    expect(writePart).toHaveBeenCalledTimes(1)
    const writtenPart = writePart.mock.calls[0][0]
    expect(writtenPart.type).toBe('text')
    expect(writtenPart.text).toBe('\n\n_[Mensaje interrumpido por el usuario]_')
    expect(writtenPart.sessionID).toBe(CHANNEL_ID)
    expect(writtenPart.messageID).toBe(assistant.info.id)
    expect(writtenPart.meta).toEqual({
      synthetic: true,
      syntheticReason: 'user_interruption',
    })
  })

  it('last assistant has text + completed tool part → writes the note', async () => {
    const assistant = makeAssistantMessage([
      { type: 'text', text: 'about to call tool' },
      { type: 'tool', state: { status: 'completed' } },
    ])
    const { stub, writePart } = makeInterruptionStub([assistant])

    await callAppendNote(stub)

    expect(writePart).toHaveBeenCalledTimes(1)
    const writtenPart = writePart.mock.calls[0][0]
    expect(writtenPart.text).toBe('\n\n_[Mensaje interrumpido por el usuario]_')
  })
})

// ---------------------------------------------------------------------------
// 2) Voice handlers propagate messageId
// ---------------------------------------------------------------------------

describe('voice handlers propagate messageId', () => {
  describe('processVoiceContent', () => {
    let processAgentResponse: ReturnType<typeof mock>
    let saveAudioFile: ReturnType<typeof mock>
    let transcribeAudioFile: ReturnType<typeof mock>
    let updateMessageContent: ReturnType<typeof mock>
    let getMessage: ReturnType<typeof mock>
    let broadcastToChannel: ReturnType<typeof mock>
    let emitSyntheticQueueDone: ReturnType<typeof mock>
    let sendError: ReturnType<typeof mock>

    function makeStub(transcription: string) {
      processAgentResponse = mock(
        async (_channelId: string, _agentId: string, _text: string, _messageId: string) => {},
      )
      saveAudioFile = mock(async (_uid: any, _data: string, _mime?: string) => ({
        filePath: '/tmp/test.wav',
        fileUrl: '/uploads/u/test.wav',
      }))
      transcribeAudioFile = mock(async (_path: string) => transcription)
      updateMessageContent = mock(async (_msgId: string, _content: any) => {})
      getMessage = mock(async (_msgId: string) => ({ id: MESSAGE_ID, content: {} }))
      broadcastToChannel = mock((_cid: string, _event: any) => {})
      emitSyntheticQueueDone = mock((_cid: string, _msgId: string) => {})
      sendError = mock((_ws: any, _code: string, _msg: string) => {})

      return {
        // private methods we override on the stub:
        saveAudioFile,
        transcribeAudioFile,
        processAgentResponse,
        broadcastToChannel,
        emitSyntheticQueueDone,
        sendError,
        channelManager: {
          updateMessageContent,
          getMessage,
        },
      }
    }

    function callProcessVoice(stub: any) {
      return (MessageHandler.prototype as any).processVoiceContent.call(
        stub,
        makeFakeWs(),
        USER_ID,
        CHANNEL_ID,
        AGENT_ID,
        MESSAGE_ID,
        {
          type: 'voice',
          data: 'base64audio==',
          mimeType: 'audio/wav',
          duration: 2,
        },
      )
    }

    it('transcribable voice → processAgentResponse called with the original messageId', async () => {
      const stub = makeStub('hola mundo')

      await callProcessVoice(stub)

      expect(transcribeAudioFile).toHaveBeenCalledTimes(1)
      expect(processAgentResponse).toHaveBeenCalledTimes(1)

      const call = processAgentResponse.mock.calls[0]
      expect(call[0]).toBe(CHANNEL_ID)
      expect(call[1]).toBe(AGENT_ID)
      expect(call[2]).toBe('hola mundo')
      expect(call[3]).toBe(MESSAGE_ID) // ← propagation
    })

    it('empty transcription (only whitespace) → emits synthetic queue_state done, no processAgentResponse', async () => {
      const stub = makeStub('   \n\t  ')

      await callProcessVoice(stub)

      expect(transcribeAudioFile).toHaveBeenCalledTimes(1)
      expect(processAgentResponse).toHaveBeenCalledTimes(0)
      expect(emitSyntheticQueueDone).toHaveBeenCalledTimes(1)
      expect(emitSyntheticQueueDone.mock.calls[0][0]).toBe(CHANNEL_ID)
      expect(emitSyntheticQueueDone.mock.calls[0][1]).toBe(MESSAGE_ID)
    })
  })

  describe('retryTranscription', () => {
    let processAgentResponse: ReturnType<typeof mock>
    let transcribeAudioFile: ReturnType<typeof mock>
    let updateMessageContent: ReturnType<typeof mock>
    let getMessage: ReturnType<typeof mock>
    let getChannel: ReturnType<typeof mock>
    let broadcastToChannel: ReturnType<typeof mock>

    function makeStub(transcription: string) {
      processAgentResponse = mock(
        async (_channelId: string, _agentId: string, _text: string, _messageId: string) => {},
      )
      transcribeAudioFile = mock(async (_path: string) => transcription)
      updateMessageContent = mock(async (_msgId: string, _content: any) => {})
      const originalMessage = {
        id: MESSAGE_ID,
        content: {
          type: 'voice',
          url: '/uploads/u/audio.wav',
          duration: 2,
          mimeType: 'audio/wav',
        },
      }
      // Two reads expected: first to load the message, second after updateContent.
      let calls = 0
      getMessage = mock(async (_msgId: string) => {
        calls += 1
        return calls === 1
          ? originalMessage
          : { ...originalMessage, content: { ...originalMessage.content, transcription } }
      })
      getChannel = mock(async (_cid: string) => ({ id: CHANNEL_ID, agentId: AGENT_ID }))
      broadcastToChannel = mock((_cid: string, _event: any) => {})

      return {
        transcribeAudioFile,
        processAgentResponse,
        broadcastToChannel,
        channelManager: {
          getMessage,
          getChannel,
          updateMessageContent,
        },
      }
    }

    function callRetry(stub: any) {
      return (MessageHandler.prototype as any).retryTranscription.call(
        stub,
        USER_ID,
        CHANNEL_ID,
        MESSAGE_ID,
      )
    }

    it('successful retry → processAgentResponse called with the retried messageId', async () => {
      const stub = makeStub('reintento ok')

      await callRetry(stub)

      expect(transcribeAudioFile).toHaveBeenCalledTimes(1)
      expect(processAgentResponse).toHaveBeenCalledTimes(1)

      const call = processAgentResponse.mock.calls[0]
      expect(call[0]).toBe(CHANNEL_ID)
      expect(call[1]).toBe(AGENT_ID)
      expect(call[2]).toBe('reintento ok')
      expect(call[3]).toBe(MESSAGE_ID) // ← propagation
    })
  })
})
