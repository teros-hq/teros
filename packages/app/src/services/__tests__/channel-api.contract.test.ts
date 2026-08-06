/**
 * ChannelApi — contract / boundary tests.
 *
 * The domain APIs are thin typed wrappers over Transport.request(action, payload,
 * options). The contract that matters is the EXACT action, payload and options
 * each method emits (a wrong field name or a dropped conditional silently breaks
 * the wire), plus ChannelApi.getMessages — which, uniquely, resolves off a
 * `messages_history` *event* filtered by channelId. That event path has a real
 * race (two getMessages for the same channel both settle on the first response)
 * and is exactly where a foreign-channel response could resolve the wrong promise.
 *
 * Runner: bun:test (pure logic, node-env).
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { ChannelApi, type IEventEmitter } from '../ChannelApi'
import { CapturingTransport, flush, track } from './_helpers'

/** An emitter that actually registers/removes/fires handlers, so leaks show up. */
class FakeEmitter implements IEventEmitter {
  handlers = new Map<string, Set<Function>>()
  on(event: string, listener: Function): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(listener)
  }
  off(event: string, listener: Function): void {
    this.handlers.get(event)?.delete(listener)
  }
  emit(event: string, data: unknown): void {
    this.handlers.get(event)?.forEach((h) => h(data))
  }
  count(event: string): number {
    return this.handlers.get(event)?.size ?? 0
  }
}

// ============================================================================
// Request payload contract — the exact frame each method emits
// ============================================================================

describe('ChannelApi — request payload contract', () => {
  let transport: CapturingTransport
  let api: ChannelApi

  beforeEach(() => {
    transport = new CapturingTransport()
    api = new ChannelApi(transport)
  })

  it('list() omits every optional field when called bare', () => {
    void api.list()
    expect(transport.last()).toEqual({ action: 'channel.list', payload: {}, options: undefined })
  })

  it('list(null) sends workspaceId:null — null means "all", undefined means "omit" (boundary)', () => {
    void api.list(null)
    // The guard is `workspaceId !== undefined`, so null is a meaningful value, not skipped.
    expect(transport.last().payload).toEqual({ workspaceId: null })
  })

  it('list() includes only the provided optional fields', () => {
    void api.list('ws_1', 'active', 10, 'cur_abc')
    expect(transport.last().payload).toEqual({
      workspaceId: 'ws_1',
      status: 'active',
      limit: 10,
      cursor: 'cur_abc',
    })
  })

  it('list(undefined, status) skips workspaceId but keeps status', () => {
    void api.list(undefined, 'closed')
    expect(transport.last().payload).toEqual({ status: 'closed' })
  })

  it('get / close / reopen / markRead / subscribe / unsubscribe send { channelId }', () => {
    api.get('ch_1')
    expect(transport.last()).toEqual({ action: 'channel.get', payload: { channelId: 'ch_1' }, options: undefined })
    api.close('ch_1')
    expect(transport.last().action).toBe('channel.close')
    api.reopen('ch_1')
    expect(transport.last().action).toBe('channel.reopen')
    api.markRead('ch_1')
    expect(transport.last().action).toBe('channel.mark-read')
    api.subscribe('ch_1')
    expect(transport.last().action).toBe('channel.subscribe')
    api.unsubscribe('ch_1')
    expect(transport.last()).toEqual({
      action: 'channel.unsubscribe',
      payload: { channelId: 'ch_1' },
      options: undefined,
    })
  })

  it('setPrivate / rename carry their second argument', () => {
    api.setPrivate('ch_1', true)
    expect(transport.last()).toEqual({
      action: 'channel.set-private',
      payload: { channelId: 'ch_1', isPrivate: true },
      options: undefined,
    })
    api.rename('ch_1', 'Nuevo nombre')
    expect(transport.last().payload).toEqual({ channelId: 'ch_1', name: 'Nuevo nombre' })
  })

  it('sendMessage omits wakeUpAgent unless explicitly provided', () => {
    const content = { type: 'text' as const, text: 'hola' }
    api.sendMessage('ch_1', content)
    expect(transport.last()).toEqual({
      action: 'channel.send-message',
      payload: { channelId: 'ch_1', content },
      options: undefined,
    })
    api.sendMessage('ch_1', content, { wakeUpAgent: false })
    expect(transport.last().payload).toEqual({ channelId: 'ch_1', content, wakeUpAgent: false })
  })

  it('stopMessage defaults to soft and forwards the kind', () => {
    api.stopMessage('ch_1')
    expect(transport.last().payload).toEqual({ channelId: 'ch_1', kind: 'soft' })
    api.stopMessage('ch_1', 'hard')
    expect(transport.last().payload).toEqual({ channelId: 'ch_1', kind: 'hard' })
  })

  it('search defaults limit to 50 and sets a 15s timeout', () => {
    api.search('teros')
    expect(transport.last()).toEqual({
      action: 'channel.search',
      payload: { query: 'teros', limit: 50 },
      options: { timeout: 15_000 },
    })
  })

  it('autoname / transcribeAudio / retryTranscription set their long timeouts', () => {
    api.autoname('ch_1')
    expect(transport.last().options).toEqual({ timeout: 30_000 })
    api.transcribeAudio('base64data', 'audio/webm')
    expect(transport.last()).toEqual({
      action: 'channel.transcribe-audio',
      payload: { data: 'base64data', mimeType: 'audio/webm' },
      options: { timeout: 30_000 },
    })
    api.retryTranscription('ch_1', 'msg_1')
    expect(transport.last().options).toEqual({ timeout: 30_000 })
  })
})

// ============================================================================
// getMessages — event-driven resolution, the channelId race, and lifecycle
// ============================================================================

describe('ChannelApi.getMessages', () => {
  let transport: CapturingTransport
  let emitter: FakeEmitter
  let api: ChannelApi

  beforeEach(() => {
    jest.useFakeTimers()
    transport = new CapturingTransport()
    emitter = new FakeEmitter()
    api = new ChannelApi(transport, emitter)
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('sends the request and resolves from the matching messages_history event', async () => {
    const p = api.getMessages('ch_1', 25, 'before_x')
    // contract of the underlying request frame
    expect(transport.last()).toEqual({
      action: 'channel.get-messages',
      payload: { channelId: 'ch_1', limit: 25, before: 'before_x' },
      options: undefined,
    })
    expect(emitter.count('messages_history')).toBe(1) // listener registered

    emitter.emit('messages_history', {
      channelId: 'ch_1',
      messages: [{ messageId: 'm1' }],
      hasMore: true,
      tokenBudget: { used: 10 },
    })
    await expect(p).resolves.toEqual({
      messages: [{ messageId: 'm1' }],
      hasMore: true,
      tokenBudget: { used: 10 },
    })
    expect(emitter.count('messages_history')).toBe(0) // listener cleaned up
  })

  it('omits `before` from the payload when not provided', () => {
    void api.getMessages('ch_1')
    expect(transport.last().payload).toEqual({ channelId: 'ch_1', limit: 50 })
  })

  it('defaults messages to [] and hasMore to false when absent (existence boundary)', async () => {
    const p = api.getMessages('ch_1')
    emitter.emit('messages_history', { channelId: 'ch_1' })
    await expect(p).resolves.toEqual({ messages: [], hasMore: false, tokenBudget: undefined })
  })

  it('a response for a different channel does NOT resolve this promise (race guard)', async () => {
    const pA = api.getMessages('ch_A')
    const pB = api.getMessages('ch_B')
    const sA = track(pA)

    emitter.emit('messages_history', { channelId: 'ch_B', messages: [{ messageId: 'b1' }], hasMore: false })
    await flush()

    expect(sA.v).toBe('pending') // ch_A still waiting — the guard kept channels apart
    await expect(pB).resolves.toEqual({ messages: [{ messageId: 'b1' }], hasMore: false, tokenBudget: undefined })
    expect(emitter.count('messages_history')).toBe(1) // only ch_A's listener remains
  })

  it('serializes calls for the same channel so each gets its own response (BUG-2)', async () => {
    const page1 = api.getMessages('ch_1', 50) // runs immediately
    const page2 = api.getMessages('ch_1', 50, 'before_x') // waits for page1 to settle
    const s2 = track(page2)

    emitter.emit('messages_history', { channelId: 'ch_1', messages: [{ id: 'newest' }], hasMore: true })
    await expect(page1).resolves.toMatchObject({ messages: [{ id: 'newest' }] })
    expect(s2.v).toBe('pending') // page2 must NOT be satisfied by page1's response

    await flush() // page2 runs now that page1 settled
    emitter.emit('messages_history', { channelId: 'ch_1', messages: [{ id: 'older' }], hasMore: false })
    await expect(page2).resolves.toMatchObject({ messages: [{ id: 'older' }] })
  })

  it('rejects and unsubscribes on timeout', async () => {
    const p = api.getMessages('ch_1')
    const s = track(p)
    p.catch(() => {})

    jest.advanceTimersByTime(9999)
    await flush()
    expect(s.v).toBe('pending')

    jest.advanceTimersByTime(1)
    await flush()
    expect(s.v).toBe('rejected')
    expect(emitter.count('messages_history')).toBe(0) // listener removed on timeout
  })

  it('rejects and unsubscribes when the underlying request fails', async () => {
    transport.rejectWith = new Error('NOT_CONNECTED')
    const p = api.getMessages('ch_1')
    await expect(p).rejects.toThrow('NOT_CONNECTED')
    expect(emitter.count('messages_history')).toBe(0)
  })

  it('a failed call does not block the next call for the same channel (serialization is fault-tolerant)', async () => {
    transport.rejectWith = new Error('boom') // first call rejects
    const p1 = api.getMessages('ch_1')
    await expect(p1).rejects.toThrow('boom')

    transport.rejectWith = null
    const p2 = api.getMessages('ch_1', 50, 'before_x') // must still run after the failure
    await flush()
    emitter.emit('messages_history', { channelId: 'ch_1', messages: [{ id: 'ok' }], hasMore: false })
    await expect(p2).resolves.toMatchObject({ messages: [{ id: 'ok' }] })
  })
})
