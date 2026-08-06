/**
 * chatStore — streaming + optimistic-id actions.
 *
 * Complements tests/unit/chatStore.test.ts (which covers setAgentPhase /
 * reorderMessageToEnd). Here:
 *  - appendTextChunk: chunk ordering (currentText + text, not the reverse), the
 *    create-vs-append branch, and not re-appending to the channel list.
 *  - updateMessageId: the optimistic→real swap must not leave a zombie (old id
 *    gone from both maps) and must preserve list position + message fields.
 *  - reorderMessageBefore: insert-before semantics and its no-op guards.
 *
 * chatStore imports only createSessionStore (no storage/react-native), so it runs
 * directly under bun:test, hitting the singleton via getState()/setState() with a
 * per-test reset.
 *
 * Runner: bun:test.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { useChatStore } from '../chatStore'
import type { Message } from '../chatStore'

function makeMessage(id: string, channelId: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    channelId,
    content: { type: 'text', text: id },
    sender: 'agent',
    timestamp: new Date(2026, 0, 1),
    ...overrides,
  }
}

function seed(messages: Message[]) {
  const byId: Record<string, Message> = {}
  const byChannel: Record<string, string[]> = {}
  for (const m of messages) {
    byId[m.id] = m
    ;(byChannel[m.channelId] ||= []).push(m.id)
  }
  useChatStore.setState({ messages: byId, channelMessages: byChannel, channels: {} })
}

const get = () => useChatStore.getState()

beforeEach(() => {
  useChatStore.setState({ messages: {}, channelMessages: {}, channels: {} })
})

// ============================================================================
// appendTextChunk
// ============================================================================

describe('appendTextChunk', () => {
  it('creates a streaming message on the first chunk and lists it', () => {
    get().appendTextChunk('m1', 'ch1', 'Hola')
    const msg = get().messages.m1
    expect(msg).toMatchObject({
      id: 'm1',
      channelId: 'ch1',
      sender: 'agent',
      isStreaming: true,
      text: 'Hola',
      content: { type: 'text', text: 'Hola' },
    })
    expect(get().channelMessages.ch1).toEqual(['m1'])
  })

  it('appends successive chunks in order (currentText + text)', () => {
    get().appendTextChunk('m1', 'ch1', 'Hola')
    get().appendTextChunk('m1', 'ch1', ' mundo')
    expect(get().messages.m1!.text).toBe('Hola mundo')
    expect(get().messages.m1!.content).toEqual({ type: 'text', text: 'Hola mundo' })
  })

  it('concatenates three chunks left-to-right', () => {
    get().appendTextChunk('m1', 'ch1', 'a')
    get().appendTextChunk('m1', 'ch1', 'b')
    get().appendTextChunk('m1', 'ch1', 'c')
    expect(get().messages.m1!.text).toBe('abc')
  })

  it('does not re-append the id to the channel list on subsequent chunks', () => {
    get().appendTextChunk('m1', 'ch1', 'a')
    get().appendTextChunk('m1', 'ch1', 'b')
    expect(get().channelMessages.ch1).toEqual(['m1']) // exactly one entry
  })

  it('treats a missing existing text as empty (no "undefined" prefix)', () => {
    seed([makeMessage('m1', 'ch1', { text: undefined, content: { type: 'text', text: '' } })])
    get().appendTextChunk('m1', 'ch1', 'X')
    expect(get().messages.m1!.text).toBe('X')
  })
})

// ============================================================================
// updateMessageId — optimistic → real swap
// ============================================================================

describe('updateMessageId', () => {
  it('swaps the id without leaving a zombie in either map', () => {
    seed([makeMessage('m_temp', 'ch1', { text: 'optimista' })])
    get().updateMessageId('m_temp', 'm_real', 'ch1')

    expect(get().messages.m_temp).toBeUndefined()
    expect(get().messages.m_real).toBeDefined()
    expect(get().messages.m_real!.id).toBe('m_real')
    expect(get().channelMessages.ch1).toEqual(['m_real'])
  })

  it('preserves list position when swapping a middle id', () => {
    seed([makeMessage('a', 'ch1'), makeMessage('m_temp', 'ch1'), makeMessage('c', 'ch1')])
    get().updateMessageId('m_temp', 'm_real', 'ch1')
    expect(get().channelMessages.ch1).toEqual(['a', 'm_real', 'c'])
  })

  it('preserves the rest of the message fields', () => {
    seed([makeMessage('m_temp', 'ch1', { text: 'hola', sender: 'agent' })])
    get().updateMessageId('m_temp', 'm_real', 'ch1')
    expect(get().messages.m_real).toMatchObject({ text: 'hola', sender: 'agent', content: { type: 'text', text: 'm_temp' } })
  })

  it('is a silent no-op when the old id is unknown', () => {
    seed([makeMessage('a', 'ch1')])
    const before = get().channelMessages.ch1
    get().updateMessageId('nope', 'm_real', 'ch1')
    expect(get().messages.m_real).toBeUndefined()
    expect(get().channelMessages.ch1).toBe(before) // same reference — untouched
  })

  it('does not duplicate when newId already exists in the channel (BUG-3)', () => {
    // Real-world race: the real message arrived via the stream before the
    // optimistic→real swap fires, so newId is already present.
    seed([makeMessage('m_real', 'ch1', { text: 'real' }), makeMessage('m_temp', 'ch1', { text: 'optimista' })])
    get().updateMessageId('m_temp', 'm_real', 'ch1')

    expect(get().channelMessages.ch1).toEqual(['m_real']) // no duplicate
    expect(get().messages.m_temp).toBeUndefined() // optimistic id gone
    // The server copy is kept, not overwritten by the optimistic one.
    expect(get().messages.m_real!.content).toEqual({ type: 'text', text: 'm_real' })
  })

  it('is a no-op when oldId === newId (does not drop the message via the dedup branch)', () => {
    seed([makeMessage('m1', 'ch1')])
    get().updateMessageId('m1', 'm1', 'ch1')
    expect(get().channelMessages.ch1).toEqual(['m1']) // must not vanish
    expect(get().messages.m1).toBeDefined()
  })
})

// ============================================================================
// reorderMessageBefore
// ============================================================================

describe('reorderMessageBefore', () => {
  it('moves a message to immediately before the target', () => {
    seed([makeMessage('a', 'ch1'), makeMessage('b', 'ch1'), makeMessage('c', 'ch1'), makeMessage('d', 'ch1')])
    get().reorderMessageBefore('ch1', 'c', 'a')
    expect(get().channelMessages.ch1).toEqual(['c', 'a', 'b', 'd'])
  })

  it('is a no-op when messageId or beforeId is absent, or the channel is unknown', () => {
    seed([makeMessage('a', 'ch1'), makeMessage('b', 'ch1')])
    const before = get().channelMessages.ch1
    get().reorderMessageBefore('ch1', 'x', 'a') // messageId absent
    get().reorderMessageBefore('ch1', 'a', 'x') // beforeId absent
    get().reorderMessageBefore('nope', 'a', 'b') // channel absent
    expect(get().channelMessages.ch1).toBe(before)
  })

  it('is a no-op (same reference) when the order is already correct', () => {
    seed([makeMessage('a', 'ch1'), makeMessage('b', 'ch1'), makeMessage('c', 'ch1')])
    const before = get().channelMessages.ch1
    get().reorderMessageBefore('ch1', 'b', 'c') // b is already right before c
    expect(get().channelMessages.ch1).toBe(before)
  })
})
