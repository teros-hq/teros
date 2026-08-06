/**
 * WsTransport — Self-contained WebSocket transport implementing the Transport interface.
 *
 * Extracted from TerosClient. Encapsulates:
 * - WebSocket connection lifecycle
 * - Reconnection with exponential backoff
 * - Heartbeat (ping/pong)
 * - Request/response correlation
 * - Message queuing while disconnected
 * - Authentication handshake
 *
 * REQ-1: Transport Abstraction
 * REQ-3: Connection Management Separation
 */

import {
  type ConnectionAckMessage,
  isAuthError,
  isAuthSuccess,
  isConnectionAck,
  isError,
  isMessageAck,
  isMessageReceived,
  isMessageSent,
  isPong,
  isSystemEvent,
  isTypingEvent,
  type MessageAck,
  type PongMessage,
} from '@teros/shared'
import type {
  EventHandler,
  RequestOptions,
  StateChangeHandler,
  Transport,
  WsTransportConfig,
} from './types'
import { ConnectionState } from './types'

// ============================================================================
// Internal types
// ============================================================================

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timeoutId: ReturnType<typeof setTimeout>
}

interface PendingAck {
  message: unknown
  serialized: string
  byteLength: number
  sentAt: number
  retryCount: number
}

interface ServerMessage {
  type: string
  requestId?: string
  [key: string]: unknown
}

// ============================================================================
// WsTransport
// ============================================================================

export class WsTransport implements Transport {
  // --- WebSocket state ---
  private ws: WebSocket | null = null
  private state: ConnectionState = ConnectionState.DISCONNECTED
  private url: string = ''
  private shouldReconnect = true
  private sessionToken: string | null = null

  // --- Request/response correlation ---
  private requestCounter = 0
  private pendingRequests = new Map<string, PendingRequest>()

  // --- Message queue (while disconnected) ---
  private messageQueue: Array<{ requestId: string; message: string }> = []

  // --- Reconnection ---
  private reconnectAttempts = 0
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null

  // --- Heartbeat ---
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private pongTimeout: ReturnType<typeof setTimeout> | null = null
  private missedPongs = 0
  private pingIntervalMs: number
  private pongTimeoutMs: number
  private maxMissedPongs: number

  // --- Config ---
  private readonly config: Required<WsTransportConfig>

  // --- Reliable delivery ---
  private messageSeq = 0
  private pendingAcks = new Map<string, PendingAck>()

  // --- Event handlers ---
  private eventHandlers = new Map<string, Set<EventHandler<unknown>>>()
  private stateHandlers = new Set<StateChangeHandler>()

  constructor(config: WsTransportConfig = {}) {
    this.config = {
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
      initialReconnectDelay: config.initialReconnectDelay ?? 1000,
      maxReconnectDelay: config.maxReconnectDelay ?? 30000,
      heartbeatInterval: config.heartbeatInterval ?? 30000,
      heartbeatTimeout: config.heartbeatTimeout ?? 10000,
      defaultTimeout: config.defaultTimeout ?? 10000,
      maxMissedPongs: config.maxMissedPongs ?? 2,
    }
    this.pingIntervalMs = this.config.heartbeatInterval
    this.pongTimeoutMs = this.config.heartbeatTimeout
    this.maxMissedPongs = this.config.maxMissedPongs
  }

  // ============================================================================
  // Transport interface — public API
  // ============================================================================

  request<TResponse = unknown>(
    action: string,
    payload?: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<TResponse> {
    const requestId = `ws_${++this.requestCounter}_${Date.now()}`
    const timeout = options?.timeout ?? this.config.defaultTimeout

    return new Promise<TResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId)
          // The caller has given up: drop the frame if it's still queued, so a
          // later reconnect doesn't silently execute an abandoned action.
          this.removeQueued(requestId)
          reject(new Error(`WsTransport: request timeout — ${action}`))
        }
      }, timeout)

      this.pendingRequests.set(requestId, {
        resolve: (v) => { clearTimeout(timeoutId); resolve(v as TResponse) },
        reject: (e) => { clearTimeout(timeoutId); reject(e) },
        timeoutId,
      })

      const message = JSON.stringify({
        type: 'request',
        requestId,
        action,
        data: payload,
        ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
      })

      if (this.state === ConnectionState.CONNECTED && this.ws) {
        this.ws.send(message)
      } else {
        this.messageQueue.push({ requestId, message })
      }
    })
  }

  subscribe<TEvent = unknown>(event: string, handler: EventHandler<TEvent>): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set())
    }
    this.eventHandlers.get(event)!.add(handler as EventHandler<unknown>)
  }

  unsubscribe<TEvent = unknown>(event: string, handler: EventHandler<TEvent>): void {
    this.eventHandlers.get(event)?.delete(handler as EventHandler<unknown>)
  }

  getState(): ConnectionState {
    return this.state
  }

  onStateChange(handler: StateChangeHandler): void {
    this.stateHandlers.add(handler)
  }

  offStateChange(handler: StateChangeHandler): void {
    this.stateHandlers.delete(handler)
  }

  // ============================================================================
  // Connection management (public, called by TerosClient facade)
  // ============================================================================

  connect(url: string): void {
    this.url = url
    this.shouldReconnect = true
    this.stopHeartbeat()

    if (this.ws) {
      this.ws.onopen = null
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.onmessage = null
      try { this.ws.close() } catch (_) { /* ignore */ }
      this.ws = null
    }

    this.setState(ConnectionState.CONNECTING)

    try {
      console.log('🔌 WsTransport: connecting to', url)
      this.ws = new WebSocket(url)
      this.ws.onopen = () => this.handleOpen()
      this.ws.onclose = (e) => this.handleClose(e)
      this.ws.onerror = (e) => this.handleError(e)
      this.ws.onmessage = (e) => this.handleMessage(e)
    } catch (err) {
      console.error('WsTransport: failed to create WebSocket', err)
      this.setState(ConnectionState.ERROR)
    }
  }

  disconnect(): void {
    this.shouldReconnect = false
    this.stopHeartbeat()
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.setState(ConnectionState.DISCONNECTED)
  }

  setSessionToken(token: string | null): void {
    this.sessionToken = token
  }

  getSessionToken(): string | null {
    return this.sessionToken
  }

  isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED
  }

  isConnecting(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.CONNECTING
  }

  getReconnectAttempts(): number {
    return this.reconnectAttempts
  }

  resetReconnection(): void {
    this.reconnectAttempts = 0
    this.shouldReconnect = true
  }

  getBackendBaseUrl(): string {
    return this.url
      .replace(/^wss:/, 'https:')
      .replace(/^ws:/, 'http:')
      .replace(/\/ws\/?$/, '')
  }

  // ============================================================================
  // Authentication (public, called by TerosClient facade)
  // ============================================================================

  async authenticate(sessionToken: string): Promise<void> {
    if (this.state !== ConnectionState.CONNECTED || !this.ws) {
      throw new Error('WsTransport: not connected')
    }
    const ws = this.ws
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.unsubscribe('authenticated', onSuccess)
        this.unsubscribe('auth_error', onError)
        reject(new Error('Authentication timeout'))
      }, 10_000)

      const onSuccess = () => {
        clearTimeout(timeoutId)
        this.unsubscribe('authenticated', onSuccess)
        this.unsubscribe('auth_error', onError)
        resolve()
      }
      const onError = (err: unknown) => {
        clearTimeout(timeoutId)
        this.unsubscribe('authenticated', onSuccess)
        this.unsubscribe('auth_error', onError)
        reject(new Error(typeof err === 'string' ? err : 'Authentication failed'))
      }

      this.subscribe('authenticated', onSuccess)
      this.subscribe('auth_error', onError)
      ws.send(JSON.stringify({ type: 'auth', method: 'token', sessionToken }))
    })
  }

  async authenticateWithCredentials(email: string, password: string): Promise<void> {
    if (this.state !== ConnectionState.CONNECTED || !this.ws) {
      throw new Error('WsTransport: not connected')
    }
    this.ws.send(JSON.stringify({ type: 'auth', method: 'credentials', email, password }))
  }

  async register(email: string, password: string, displayName: string): Promise<void> {
    if (this.state !== ConnectionState.CONNECTED || !this.ws) {
      throw new Error('WsTransport: not connected')
    }
    this.ws.send(JSON.stringify({ type: 'auth', method: 'register', email, password, displayName }))
  }

  // ============================================================================
  // WebSocket event handlers (private)
  // ============================================================================

  private async handleOpen(): Promise<void> {
    this.reconnectAttempts = 0
    // Reset the missed-pong counter so a fresh connection isn't killed by a stale
    // count carried over from the dead one (it would die after a single miss).
    this.missedPongs = 0
    console.log('🔌 WsTransport: connected')

    // Mark as CONNECTED before authenticating so that authenticate() can
    // verify the state guard (state === CONNECTED) and send the auth frame.
    this.setState(ConnectionState.CONNECTED)

    if (this.sessionToken) {
      try {
        await this.authenticate(this.sessionToken)
      } catch (err: unknown) {
        console.error('WsTransport: authentication failed', err)
        this.sessionToken = null
        this.shouldReconnect = false
        this.setState(ConnectionState.ERROR)
        this.emit('auth_failed', { reason: 'auth_error', message: (err as Error)?.message })
        return
      }
    }

    this.emit('connected', undefined)
    this.processMessageQueue()
  }

  private handleClose(event: CloseEvent): void {
    this.stopHeartbeat()
    const wasConnected = this.state === ConnectionState.CONNECTED
    console.log('👋 WsTransport: closed', { code: event.code, reason: event.reason })
    this.emit('disconnected', { code: event.code, reason: event.reason, wasClean: event.wasClean })

    if (this.shouldReconnect && this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.setState(ConnectionState.RECONNECTING)
      this.scheduleReconnect()
    } else if (this.shouldReconnect) {
      console.error('WsTransport: max reconnection attempts reached')
      this.setState(ConnectionState.ERROR)
      this.emit('error', { code: 'NETWORK_ERROR', message: 'Could not reconnect to the server.' })
    } else {
      this.setState(ConnectionState.DISCONNECTED)
    }

    // Reject all pending requests
    if (wasConnected) {
      this.rejectPendingRequests(new Error('WebSocket connection closed'))
    }
  }

  private handleError(error: Event): void {
    console.error('WsTransport: WebSocket error', error)
    this.emit('connection_error', { message: (error as ErrorEvent).message })
  }

  private handleMessage(event: MessageEvent): void {
    let message: ServerMessage
    try {
      message = JSON.parse(event.data as string)
    } catch (err) {
      console.error('WsTransport: failed to parse message', err)
      return
    }
    this.routeMessage(message)
  }

  // ============================================================================
  // Message routing (private)
  // ============================================================================

  private routeMessage(message: ServerMessage): void {
    // Request/response correlation
    if (message.requestId && this.pendingRequests.has(message.requestId as string)) {
      const pending = this.pendingRequests.get(message.requestId as string)!
      this.pendingRequests.delete(message.requestId as string)

      if (message.type === 'error') {
        const errPayload = (message.data as Record<string, unknown>) ?? { code: message.code, message: message.message }
        const errMsg = (errPayload as { message?: string }).message ?? `WsFramework error`
        // Preserve the backend's error code on the rejected Error so callers can branch
        // on the contract (FORBIDDEN / NOT_FOUND / RATE_LIMITED / LLM_ERROR…) instead of
        // string-matching the message. Additive: readers of `.message` are unaffected;
        // consumers already reading `err.code` (useChatChannel classification,
        // FeatureFlags/Users/AgentUsage admin gating) got `undefined` until now.
        const code = (errPayload as { code?: string }).code ?? (message.code as string | undefined)
        const err = new Error(String(errMsg)) as Error & { code?: string }
        if (code) err.code = code
        pending.reject(err)
        return
      }
      if (message.type === 'response') {
        pending.resolve(message.data)
        return
      }
      if (message.type === 'ack') {
        pending.resolve(message.data)
        return
      }
    }

    // Protocol handlers
    if (isConnectionAck(message as any)) {
      this.handleConnectionAck(message as unknown as ConnectionAckMessage)
      return
    }
    if (isPong(message as any)) {
      this.handlePong(message as unknown as PongMessage)
      return
    }
    if (isMessageAck(message as any)) {
      this.handleMessageAck(message as unknown as MessageAck)
      return
    }
    if (isAuthSuccess(message as any)) {
      this.sessionToken = (message as any).sessionToken ?? this.sessionToken
      this.emit('authenticated', message)
      return
    }
    if (isAuthError(message as any)) {
      this.emit('auth_error', (message as any).error)
      return
    }
    if (isError(message as any)) {
      this.emit('error', message)
      return
    }
    if (isMessageReceived(message as any)) {
      this.emit('message', message)
      return
    }
    if (isTypingEvent(message as any)) {
      this.emit('typing', message)
      return
    }
    if (isSystemEvent(message as any)) {
      this.emit('system_event', message)
      return
    }
    if (isMessageSent(message as any)) {
      this.emit('message_sent', message)
      return
    }

    // PubSub push events: { type: 'event', event: '<name>', data: {...} }
    if (message.type === 'event') {
      this.emit((message as any).event, (message as any).data)
      return
    }

    // Generic event routing by type
    this.emit(message.type, message)
  }

  // ============================================================================
  // Heartbeat (private)
  // ============================================================================

  private handleConnectionAck(message: ConnectionAckMessage): void {
    this.pingIntervalMs = message.config.pingIntervalMs
    this.pongTimeoutMs = message.config.pongTimeoutMs
    console.log(`🤝 WsTransport: protocol config — ping ${this.pingIntervalMs}ms, pong timeout ${this.pongTimeoutMs}ms`)
    this.startHeartbeat()
    this.emit('connection_ack', message)
  }

  private handlePong(message: PongMessage): void {
    if (this.pongTimeout) { clearTimeout(this.pongTimeout); this.pongTimeout = null }
    this.missedPongs = 0
    const rtt = Date.now() - message.clientTime
    console.log(`🏓 WsTransport: pong RTT ${rtt}ms`)
    this.emit('pong', { rtt, serverTime: message.serverTime })
  }

  private handleMessageAck(ack: MessageAck): void {
    const pending = this.pendingAcks.get(ack.requestId)
    if (!pending) { this.emit('message_ack', ack); return }

    if (ack.status === 'error' || ack.receivedBytes !== pending.byteLength) {
      const maxRetries = 3
      if (pending.retryCount < maxRetries && this.ws) {
        pending.retryCount++
        pending.sentAt = Date.now()
        this.ws.send(pending.serialized)
        this.emit('message_retry', { requestId: ack.requestId, attempt: pending.retryCount })
      } else {
        this.pendingAcks.delete(ack.requestId)
        this.emit('message_failed', { requestId: ack.requestId, reason: 'max_retries_exceeded' })
      }
    } else {
      this.pendingAcks.delete(ack.requestId)
      this.emit('message_ack', ack)
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.pingInterval = setInterval(() => this.sendPing(), this.pingIntervalMs)
    this.sendPing()
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null }
    if (this.pongTimeout) { clearTimeout(this.pongTimeout); this.pongTimeout = null }
  }

  private sendPing(): void {
    if (this.state !== ConnectionState.CONNECTED || !this.ws) return
    const clientTime = Date.now()
    try {
      this.ws.send(JSON.stringify({ type: 'ping', clientTime }))
      this.pongTimeout = setTimeout(() => {
        this.missedPongs++
        console.warn(`WsTransport: pong timeout (missed: ${this.missedPongs}/${this.maxMissedPongs})`)
        if (this.missedPongs >= this.maxMissedPongs) {
          console.error('WsTransport: connection dead, forcing reconnect')
          this.emit('connection_dead', { missedPongs: this.missedPongs })
          this.stopHeartbeat()
          this.ws?.close()
        }
      }, this.pongTimeoutMs)
    } catch (err) {
      console.error('WsTransport: failed to send ping', err)
    }
  }

  // ============================================================================
  // Reconnection (private)
  // ============================================================================

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout)
    this.reconnectAttempts++
    const delay = Math.min(
      this.config.initialReconnectDelay * 2 ** (this.reconnectAttempts - 1),
      this.config.maxReconnectDelay,
    )
    console.log(`🔄 WsTransport: reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`)
    this.reconnectTimeout = setTimeout(() => this.connect(this.url), delay)
  }

  // ============================================================================
  // Helpers (private)
  // ============================================================================

  private processMessageQueue(): void {
    while (this.messageQueue.length > 0 && this.state === ConnectionState.CONNECTED && this.ws) {
      const queued = this.messageQueue.shift()!
      this.ws.send(queued.message)
    }
  }

  /** Drop a queued (not-yet-sent) frame once its caller has given up on it. */
  private removeQueued(requestId: string): void {
    const i = this.messageQueue.findIndex((m) => m.requestId === requestId)
    if (i >= 0) this.messageQueue.splice(i, 1)
  }

  private rejectPendingRequests(error: Error): void {
    this.pendingRequests.forEach((pending) => {
      pending.reject(error)
    })
    this.pendingRequests.clear()
    // Their queued (unsent) frames must not be flushed on a later reconnect.
    this.messageQueue = []
  }

  private setState(newState: ConnectionState): void {
    if (this.state === newState) return
    this.state = newState
    this.stateHandlers.forEach((h) => h(newState))
  }

  private emit<T>(event: string, data: T): void {
    const handlers = this.eventHandlers.get(event)
    handlers?.forEach((h) => {
      try { h(data) } catch (err) { console.error(`WsTransport: handler error for "${event}"`, err) }
    })
  }
}
