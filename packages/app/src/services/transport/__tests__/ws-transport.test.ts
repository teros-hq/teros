/**
 * WsTransport — boundary-faithful unit tests.
 *
 * WsTransport is the highest-blast-radius module in the frontend (~19KB, 0 tests
 * before this): a bug in backoff, dead-connection detection or request
 * correlation leaves every user a zombie with no recovery. We drive it through a
 * FakeWebSocket that replicates the real boundary (CONNECTING-first, send-only-
 * when-OPEN, close decoupled from the close event) and fake timers, asserting the
 * exact frames it sends and the exact way it correlates responses.
 *
 * Runner: bun:test (pure transport logic, node-env — no render harness needed).
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { WsTransport } from '../ws-transport'
import { ConnectionState } from '../types'
import { FakeWebSocket } from './_fake-websocket'

const RealWebSocket = globalThis.WebSocket

let logSpy: ReturnType<typeof jest.spyOn>
let warnSpy: ReturnType<typeof jest.spyOn>
let errorSpy: ReturnType<typeof jest.spyOn>

beforeEach(() => {
  ;(globalThis as any).WebSocket = FakeWebSocket
  FakeWebSocket.reset()
  jest.useFakeTimers()
  // WsTransport logs heavily; keep test output readable.
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  jest.useRealTimers()
  logSpy.mockRestore()
  warnSpy.mockRestore()
  errorSpy.mockRestore()
  ;(globalThis as any).WebSocket = RealWebSocket
})

// --- helpers ---

/** Connect and open a transport, returning the live fake socket. */
function connectOpen(t: WsTransport, url = 'wss://example/ws'): FakeWebSocket {
  t.connect(url)
  const ws = FakeWebSocket.last()
  ws.simulateOpen()
  return ws
}

/** Drain the microtask queue (promise continuations) under fake timers. */
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

/** Track a promise's settlement without consuming it. */
function track(p: Promise<unknown>) {
  const s = { v: 'pending' as 'pending' | 'resolved' | 'rejected' }
  p.then(
    () => {
      s.v = 'resolved'
    },
    () => {
      s.v = 'rejected'
    },
  )
  return s
}

/** A valid connection_ack frame with the given heartbeat config. */
function ackFrame(pingIntervalMs: number, pongTimeoutMs: number) {
  return {
    type: 'connection_ack',
    sessionId: 'sess_1',
    serverTime: 1,
    serverVersion: '1.0.0',
    config: { pingIntervalMs, pongTimeoutMs, maxMessageSizeBytes: 10_000_000, ackRequiredAboveBytes: 10_000 },
  }
}

// ============================================================================
// Connection lifecycle
// ============================================================================

describe('connection lifecycle', () => {
  it('connect() enters CONNECTING and constructs a socket with the url', () => {
    const t = new WsTransport()
    t.connect('wss://example/ws')
    expect(t.getState()).toBe(ConnectionState.CONNECTING)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.last().url).toBe('wss://example/ws')
  })

  it('opening without a session token reaches CONNECTED and emits "connected"', () => {
    const t = new WsTransport()
    const connected = jest.fn()
    t.subscribe('connected', connected)
    connectOpen(t)
    expect(t.getState()).toBe(ConnectionState.CONNECTED)
    expect(connected).toHaveBeenCalledTimes(1)
    expect(connected).toHaveBeenCalledWith(undefined)
  })

  it('re-connecting closes the previous socket and creates a fresh one', () => {
    const t = new WsTransport()
    t.connect('wss://example/ws')
    const ws1 = FakeWebSocket.last()
    t.connect('wss://other/ws')
    expect(ws1.closeCalls).toHaveLength(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.last().url).toBe('wss://other/ws')
  })

  it('disconnect() closes the socket and reaches DISCONNECTED', () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    t.disconnect()
    expect(t.getState()).toBe(ConnectionState.DISCONNECTED)
    expect(ws.closeCalls).toHaveLength(1)
  })
})

// ============================================================================
// Request / response correlation
// ============================================================================

describe('request/response correlation', () => {
  it('sends the exact request frame and no sessionToken when unauthenticated', () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    void t.request('channel.create', { agentId: 'agent_1' })
    const frame = ws.lastSent()
    expect(frame).toEqual({
      type: 'request',
      requestId: frame.requestId,
      action: 'channel.create',
      data: { agentId: 'agent_1' },
    })
    expect(frame.requestId).toMatch(/^ws_1_\d+$/)
    expect('sessionToken' in frame).toBe(false)
  })

  it('includes the sessionToken in the frame once set', () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    t.setSessionToken('tok_abc')
    void t.request('channel.list')
    expect(ws.lastSent().sessionToken).toBe('tok_abc')
  })

  it('resolves the request when a response with the matching requestId arrives', async () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const p = t.request<{ channels: unknown[] }>('channel.list')
    const { requestId } = ws.lastSent()
    ws.simulateMessage({ type: 'response', requestId, data: { channels: [{ channelId: 'ch_1' }] } })
    await expect(p).resolves.toEqual({ channels: [{ channelId: 'ch_1' }] })
  })

  it('does NOT resolve a request when a response carries a foreign requestId (correlation)', async () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const p = t.request('channel.get')
    const { requestId } = ws.lastSent()
    const s = track(p)

    // A response for a different request must not settle this promise.
    ws.simulateMessage({ type: 'response', requestId: 'ws_999_0', data: { wrong: true } })
    await flush()
    expect(s.v).toBe('pending')

    // The matching response resolves it.
    ws.simulateMessage({ type: 'response', requestId, data: { right: true } })
    await expect(p).resolves.toEqual({ right: true })
  })

  it('rejects with the server message on an error response (data.message)', async () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const p = t.request('channel.create')
    const { requestId } = ws.lastSent()
    ws.simulateMessage({ type: 'error', requestId, data: { code: 'BAD', message: 'workspace required' } })
    await expect(p).rejects.toThrow('workspace required')
  })

  it('rejects using top-level message when an error response has no data', async () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const p = t.request('channel.create')
    const { requestId } = ws.lastSent()
    ws.simulateMessage({ type: 'error', requestId, code: 'BAD', message: 'top-level boom' })
    await expect(p).rejects.toThrow('top-level boom')
  })

  it('preserves the backend error code on the rejected Error (data.code)', async () => {
    // The code is the error CONTRACT — callers branch on it (authz gating in
    // FeatureFlags/Users, error classification in useChatChannel). Dropping it
    // (the bug) left those reads `undefined` and silently broken. Mutation:
    // revert `if (code) err.code = code` in ws-transport.ts → this goes red.
    const t = new WsTransport()
    const ws = connectOpen(t)
    const p = t.request('project.delete')
    const { requestId } = ws.lastSent()
    ws.simulateMessage({ type: 'error', requestId, data: { code: 'FORBIDDEN', message: 'No access to this project' } })
    const err = (await p.then(() => null, (e) => e)) as (Error & { code?: string }) | null
    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toBe('No access to this project')
    expect(err?.code).toBe('FORBIDDEN')
  })

  it('preserves the error code from a top-level error frame with no data', async () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const p = t.request('agent.update')
    const { requestId } = ws.lastSent()
    ws.simulateMessage({ type: 'error', requestId, code: 'RATE_LIMITED', message: 'slow down' })
    const err = (await p.then(() => null, (e) => e)) as (Error & { code?: string }) | null
    expect(err?.code).toBe('RATE_LIMITED')
    expect(err?.message).toBe('slow down')
  })

  it('resolves with data on an ack response', async () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const p = t.request('channel.mark-read')
    const { requestId } = ws.lastSent()
    ws.simulateMessage({ type: 'ack', requestId, data: { channelId: 'ch_1' } })
    await expect(p).resolves.toEqual({ channelId: 'ch_1' })
  })

  it('times out exactly at defaultTimeout and rejects (boundary)', async () => {
    const t = new WsTransport({ defaultTimeout: 5000 })
    connectOpen(t)
    const p = t.request('channel.autoname')
    const s = track(p)
    let reason: unknown
    p.catch((e) => {
      reason = e
    })

    jest.advanceTimersByTime(4999)
    await flush()
    expect(s.v).toBe('pending')

    jest.advanceTimersByTime(1)
    await flush()
    expect(s.v).toBe('rejected')
    expect((reason as Error).message).toBe('WsTransport: request timeout — channel.autoname')
  })

  it('honors a per-request timeout override over the default', async () => {
    const t = new WsTransport({ defaultTimeout: 5000 })
    connectOpen(t)
    const p = t.request('channel.search', {}, { timeout: 1000 })
    const s = track(p)
    p.catch(() => {})

    // Default would fire at 5000; the override fires at 1000.
    jest.advanceTimersByTime(999)
    await flush()
    expect(s.v).toBe('pending')

    jest.advanceTimersByTime(1)
    await flush()
    expect(s.v).toBe('rejected')
  })

  it('ignores a late response after the request already timed out', async () => {
    const t = new WsTransport({ defaultTimeout: 1000 })
    const ws = connectOpen(t)
    const p = t.request('channel.get')
    const { requestId } = ws.lastSent()
    jest.advanceTimersByTime(1000)
    await expect(p).rejects.toThrow('request timeout')
    // A response that arrives after the timeout is a no-op (request already gone).
    expect(() => ws.simulateMessage({ type: 'response', requestId, data: { late: true } })).not.toThrow()
  })
})

// ============================================================================
// Message queue while disconnected
// ============================================================================

describe('message queue while disconnected', () => {
  it('queues requests issued before open and flushes them FIFO on open', () => {
    const t = new WsTransport()
    t.connect('wss://example/ws')
    const ws = FakeWebSocket.last() // CONNECTING, not yet open
    void t.request('a.first', { n: 1 })
    void t.request('a.second', { n: 2 })
    expect(ws.sent).toHaveLength(0) // queued, not sent while connecting

    ws.simulateOpen()
    expect(ws.sent).toHaveLength(2)
    expect(ws.sentJson().map((f) => f.action)).toEqual(['a.first', 'a.second'])
  })
})

// ============================================================================
// Reconnection backoff
// ============================================================================

describe('reconnection backoff', () => {
  it('schedules a reconnect on an unclean close and enters RECONNECTING', () => {
    const t = new WsTransport({ initialReconnectDelay: 1000 })
    const ws = connectOpen(t)
    ws.simulateServerClose(1006)
    expect(t.getState()).toBe(ConnectionState.RECONNECTING)

    jest.advanceTimersByTime(999)
    expect(FakeWebSocket.instances).toHaveLength(1) // not yet
    jest.advanceTimersByTime(1)
    expect(FakeWebSocket.instances).toHaveLength(2) // reconnected
  })

  it('applies exponential backoff with a max-delay clamp', () => {
    const t = new WsTransport({ initialReconnectDelay: 1000, maxReconnectDelay: 8000, maxReconnectAttempts: 10 })
    connectOpen(t)

    // attempt:    1     2     3     4      5 (clamped)
    const delays = [1000, 2000, 4000, 8000, 8000]
    let sockets = 1 // the initial socket
    for (const delay of delays) {
      FakeWebSocket.last().simulateServerClose(1006) // drop the current (unopened) socket
      jest.advanceTimersByTime(delay - 1)
      expect(FakeWebSocket.instances).toHaveLength(sockets)
      jest.advanceTimersByTime(1)
      expect(FakeWebSocket.instances).toHaveLength(sockets + 1)
      sockets++
    }
  })

  it('stops after maxReconnectAttempts and emits a NETWORK_ERROR', () => {
    const t = new WsTransport({ initialReconnectDelay: 1, maxReconnectDelay: 1, maxReconnectAttempts: 3 })
    const errored = jest.fn()
    t.subscribe('error', errored)
    connectOpen(t)

    // 3 reconnect attempts consume the budget...
    for (let i = 0; i < 3; i++) {
      FakeWebSocket.last().simulateServerClose(1006)
      jest.advanceTimersByTime(1)
    }
    // ...the next drop finds attempts === max and gives up.
    FakeWebSocket.last().simulateServerClose(1006)

    expect(t.getState()).toBe(ConnectionState.ERROR)
    expect(errored).toHaveBeenCalledTimes(1)
    expect(errored).toHaveBeenCalledWith({
      code: 'NETWORK_ERROR',
      message: 'Could not reconnect to the server.',
    })
  })

  it('rejects in-flight requests when a live connection drops', async () => {
    const t = new WsTransport({ initialReconnectDelay: 1000 })
    const ws = connectOpen(t)
    const p = t.request('channel.list')
    ws.simulateServerClose(1006)
    await expect(p).rejects.toThrow('WebSocket connection closed')
  })

  it('does not reconnect after an explicit disconnect()', () => {
    const t = new WsTransport({ initialReconnectDelay: 1000 })
    const ws = connectOpen(t)
    t.disconnect()
    ws.simulateServerClose(1006) // a stray close event must not revive it
    jest.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(t.getState()).toBe(ConnectionState.DISCONNECTED)
  })
})

// ============================================================================
// Heartbeat / dead-connection detection
// ============================================================================

describe('heartbeat / dead-connection', () => {
  it('starts the heartbeat on connection_ack and pings immediately', () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    ws.simulateMessage(ackFrame(1000, 500))
    const ping = ws.lastSent()
    expect(ping.type).toBe('ping')
    expect(typeof ping.clientTime).toBe('number')
  })

  it('sends a ping on every heartbeat interval', () => {
    // High maxMissedPongs isolates the interval cadence from dead-connection
    // detection (covered in its own test), so the socket stays alive past t=2000.
    const t = new WsTransport({ maxMissedPongs: 10 })
    const ws = connectOpen(t)
    ws.simulateMessage(ackFrame(1000, 500)) // immediate ping #1
    const pingsAfterAck = ws.sentJson().filter((f) => f.type === 'ping').length
    jest.advanceTimersByTime(1000) // ping #2
    jest.advanceTimersByTime(1000) // ping #3
    const pings = ws.sentJson().filter((f) => f.type === 'ping').length
    expect(pingsAfterAck).toBe(1)
    expect(pings).toBe(3)
  })

  it('a pong resets the missed-pong counter and emits the round-trip time', () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const pong = jest.fn()
    t.subscribe('pong', pong)
    ws.simulateMessage(ackFrame(1000, 500))
    ws.simulateMessage({ type: 'pong', clientTime: 0, serverTime: 5 })
    expect(pong).toHaveBeenCalledTimes(1)
    expect(pong.mock.calls[0][0]).toMatchObject({ serverTime: 5 })
    expect(typeof (pong.mock.calls[0][0] as { rtt: number }).rtt).toBe('number')
  })

  it('forces a reconnect after maxMissedPongs unanswered pings', () => {
    const t = new WsTransport({ maxMissedPongs: 2 })
    const ws = connectOpen(t)
    const dead = jest.fn()
    t.subscribe('connection_dead', dead)
    ws.simulateMessage(ackFrame(1000, 500)) // ping#1 @0, pong timeout @500

    jest.advanceTimersByTime(500) // missed #1
    expect(dead).not.toHaveBeenCalled()
    jest.advanceTimersByTime(500) // ping#2 @1000, arms pong timeout @1500
    jest.advanceTimersByTime(500) // missed #2 -> dead
    expect(dead).toHaveBeenCalledTimes(1)
    expect(dead).toHaveBeenCalledWith({ missedPongs: 2 })
    expect(ws.closeCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('a timely pong prevents the dead-connection (boundary)', () => {
    const t = new WsTransport({ maxMissedPongs: 2 })
    const ws = connectOpen(t)
    const dead = jest.fn()
    t.subscribe('connection_dead', dead)
    ws.simulateMessage(ackFrame(1000, 500))

    jest.advanceTimersByTime(500) // missed #1
    ws.simulateMessage({ type: 'pong', clientTime: 0, serverTime: 1 }) // reset to 0
    jest.advanceTimersByTime(1000) // ping#2 @1000 + its pong timeout window opens
    ws.simulateMessage({ type: 'pong', clientTime: 0, serverTime: 2 }) // reset again
    jest.advanceTimersByTime(1000)
    expect(dead).not.toHaveBeenCalled()
  })
})

// ============================================================================
// Authentication handshake
// ============================================================================

describe('authentication handshake', () => {
  it('sends the auth frame on open and resolves the handshake on auth_success', async () => {
    const t = new WsTransport()
    const connected = jest.fn()
    t.subscribe('connected', connected)
    t.setSessionToken('tok_initial')
    t.connect('wss://example/ws')
    const ws = FakeWebSocket.last()
    ws.simulateOpen()

    expect(ws.sentJson()[0]).toEqual({ type: 'auth', method: 'token', sessionToken: 'tok_initial' })
    expect(connected).not.toHaveBeenCalled() // not until auth completes

    ws.simulateMessage({ type: 'auth_success', userId: 'user_abc', sessionToken: 'tok_refreshed' })
    await flush()

    expect(connected).toHaveBeenCalledTimes(1)
    expect(t.getSessionToken()).toBe('tok_refreshed') // updated from the ack
  })

  it('on auth failure: clears token, stops reconnect, ERROR, emits auth_failed', async () => {
    const t = new WsTransport()
    const authFailed = jest.fn()
    t.subscribe('auth_failed', authFailed)
    t.setSessionToken('tok_bad')
    t.connect('wss://example/ws')
    const ws = FakeWebSocket.last()
    ws.simulateOpen()
    ws.simulateMessage({ type: 'auth_error', error: 'invalid token' })
    await flush()

    expect(t.getState()).toBe(ConnectionState.ERROR)
    expect(t.getSessionToken()).toBeNull()
    expect(authFailed).toHaveBeenCalledWith({ reason: 'auth_error', message: 'invalid token' })

    // shouldReconnect was turned off — a later drop must not revive the socket.
    ws.simulateServerClose(1006)
    jest.advanceTimersByTime(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('authenticate() rejects on timeout', async () => {
    const t = new WsTransport()
    connectOpen(t) // CONNECTED, no token -> no auto-auth
    const p = t.authenticate('tok')
    jest.advanceTimersByTime(10_000)
    await expect(p).rejects.toThrow('Authentication timeout')
  })

  it('authenticate() rejects when not connected', async () => {
    const t = new WsTransport()
    await expect(t.authenticate('tok')).rejects.toThrow('not connected')
  })
})

// ============================================================================
// Connection-state notifications
// ============================================================================

describe('connection-state notifications', () => {
  it('notifies handlers on each transition', () => {
    const t = new WsTransport()
    const onState = jest.fn()
    t.onStateChange(onState)
    t.connect('wss://example/ws')
    FakeWebSocket.last().simulateOpen()
    t.disconnect()
    expect(onState.mock.calls.map((c) => c[0])).toEqual([
      ConnectionState.CONNECTING,
      ConnectionState.CONNECTED,
      ConnectionState.DISCONNECTED,
    ])
  })

  it('does not notify when the state is unchanged', () => {
    const t = new WsTransport()
    connectOpen(t)
    t.disconnect() // -> DISCONNECTED
    const onState = jest.fn()
    t.onStateChange(onState)
    t.disconnect() // already DISCONNECTED -> no-op
    expect(onState).not.toHaveBeenCalled()
  })

  it('offStateChange removes the handler', () => {
    const t = new WsTransport()
    const onState = jest.fn()
    t.onStateChange(onState)
    t.offStateChange(onState)
    t.connect('wss://example/ws')
    expect(onState).not.toHaveBeenCalled()
  })
})

// ============================================================================
// Event routing
// ============================================================================

describe('event routing', () => {
  it('routes a server error frame to "error" subscribers', () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const onError = jest.fn()
    t.subscribe('error', onError)
    ws.simulateMessage({ type: 'error', code: 'X', message: 'm' })
    expect(onError).toHaveBeenCalledWith({ type: 'error', code: 'X', message: 'm' })
  })

  it('routes a PubSub event { type:"event", event, data } to named subscribers', () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const onBoard = jest.fn()
    t.subscribe('board.updated', onBoard)
    ws.simulateMessage({ type: 'event', event: 'board.updated', data: { boardId: 'b1' } })
    expect(onBoard).toHaveBeenCalledWith({ boardId: 'b1' })
  })

  it('routes a typing event', () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const onTyping = jest.fn()
    t.subscribe('typing', onTyping)
    const msg = { type: 'typing', channelId: 'ch_1', agentId: 'agent_1', isTyping: true }
    ws.simulateMessage(msg)
    expect(onTyping).toHaveBeenCalledWith(msg)
  })

  it('falls back to generic by-type routing for unknown frames', () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const onCustom = jest.fn()
    t.subscribe('custom_event', onCustom)
    ws.simulateMessage({ type: 'custom_event', foo: 1 })
    expect(onCustom).toHaveBeenCalledWith({ type: 'custom_event', foo: 1 })
  })

  it('an event handler that throws does not stop the others', () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const bad = jest.fn(() => {
      throw new Error('handler boom')
    })
    const good = jest.fn()
    t.subscribe('custom_event', bad)
    t.subscribe('custom_event', good)
    ws.simulateMessage({ type: 'custom_event' })
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe removes the handler', () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const onX = jest.fn()
    t.subscribe('custom_event', onX)
    t.unsubscribe('custom_event', onX)
    ws.simulateMessage({ type: 'custom_event' })
    expect(onX).not.toHaveBeenCalled()
  })
})

// ============================================================================
// Reliable delivery (message_ack) — characterization
// ============================================================================

describe('message_ack (characterization)', () => {
  // The retry loop in handleMessageAck reads `pendingAcks`, but nothing in the
  // codebase ever calls `pendingAcks.set(...)` — the map is never populated, so
  // the retry branch is unreachable dead code and only the no-pending path runs.
  // Finding logged for TER-478 (dead-code accumulation); not fixed here.
  it('emits "message_ack" for an incoming ack (no pending entry exists)', () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const onAck = jest.fn()
    t.subscribe('message_ack', onAck)
    const ack = { type: 'message_ack', requestId: 'r1', receivedBytes: 10, status: 'received', serverTime: 1 }
    ws.simulateMessage(ack)
    expect(onAck).toHaveBeenCalledWith(ack)
  })
})

// ============================================================================
// Misc helpers
// ============================================================================

describe('misc helpers', () => {
  it('getBackendBaseUrl strips the ws scheme and /ws suffix', () => {
    const t = new WsTransport()
    t.connect('wss://api.example.com/ws')
    expect(t.getBackendBaseUrl()).toBe('https://api.example.com')
    const t2 = new WsTransport()
    t2.connect('ws://localhost:10001/ws')
    expect(t2.getBackendBaseUrl()).toBe('http://localhost:10001')
  })

  it('resetReconnection clears attempts and re-enables reconnect', () => {
    const t = new WsTransport({ initialReconnectDelay: 1000 })
    const ws = connectOpen(t)
    ws.simulateServerClose(1006)
    expect(t.getReconnectAttempts()).toBe(1)
    t.resetReconnection()
    expect(t.getReconnectAttempts()).toBe(0)
  })

  it('isConnecting reflects the CONNECTING socket; isConnected the OPEN socket', () => {
    const t = new WsTransport()
    t.connect('wss://example/ws')
    expect(t.isConnecting()).toBe(true)
    expect(t.isConnected()).toBe(false)
    FakeWebSocket.last().simulateOpen()
    expect(t.isConnecting()).toBe(false)
    expect(t.isConnected()).toBe(true)
  })
})

// ============================================================================
// Regressions — bugs found while writing this suite, fixed in this PR
// ============================================================================

describe('regressions', () => {
  it('does not flush a request that already timed out while disconnected (BUG-4)', async () => {
    const t = new WsTransport({ defaultTimeout: 1000 })
    t.connect('wss://example/ws')
    const ws = FakeWebSocket.last() // CONNECTING — the request is queued, not sent
    const p = t.request('channel.create', { agentId: 'a' })
    p.catch(() => {})
    jest.advanceTimersByTime(1000) // the caller's request times out — it gave up
    await flush()
    ws.simulateOpen() // connection finally opens → processMessageQueue
    // The abandoned frame must NOT reach the server: it would execute the action,
    // and the user already retried after seeing it "fail" → silent duplicate.
    expect(ws.sentJson().map((f) => f.action)).not.toContain('channel.create')
  })

  it('resets missedPongs on reconnect so a fresh connection tolerates maxMissedPongs (BUG-1)', () => {
    const t = new WsTransport({ maxMissedPongs: 2 })
    const ws1 = connectOpen(t)
    ws1.simulateMessage(ackFrame(1000, 500))
    jest.advanceTimersByTime(500) // one missed pong on the OLD connection

    t.connect('wss://example/ws') // reconnect — same transport instance
    const ws2 = FakeWebSocket.last()
    ws2.simulateOpen()
    const dead = jest.fn()
    t.subscribe('connection_dead', dead)
    ws2.simulateMessage(ackFrame(1000, 500))
    jest.advanceTimersByTime(500) // a SINGLE missed pong on the fresh connection
    expect(dead).not.toHaveBeenCalled() // 1 < maxMissedPongs — must survive
  })
})
