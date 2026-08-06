/**
 * FakeWebSocket — boundary-faithful stand-in for the global WebSocket, used to
 * test WsTransport without a real connection.
 *
 * Fidelity rules (lección TER-369: un mock no puede ser más permisivo que el
 * boundary real, o esconde bugs):
 * - A fresh socket starts in CONNECTING; it does NOT open synchronously.
 * - send() only works when OPEN; calling it in any other state throws, exactly
 *   like the browser (InvalidStateError). This catches a transport that sends
 *   before the connection is ready.
 * - close() transitions to CLOSED but does NOT fire onclose synchronously — in
 *   the real API the close event is a *separate* asynchronous emission. The test
 *   drives it explicitly via simulateServerClose(), so close-handling is never
 *   coupled to the act of calling close().
 * - The four readyState constants exist as static members (WsTransport reads
 *   `WebSocket.CONNECTING`).
 *
 * Usage: install on globalThis.WebSocket, call transport.connect(url), grab
 * FakeWebSocket.last(), then drive the boundary with simulateOpen /
 * simulateMessage / simulateServerClose / simulateError and assert what the
 * transport sent via `.sent` / `.lastSent()`.
 */

export interface FakeCloseEvent {
  code: number
  reason: string
  wasClean: boolean
}

export class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  /** Every socket the transport has constructed, in order. */
  static instances: FakeWebSocket[] = []
  static last(): FakeWebSocket {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
    if (!ws) throw new Error('FakeWebSocket.last(): no socket was constructed')
    return ws
  }
  static reset(): void {
    FakeWebSocket.instances = []
  }

  // Instance-level constants (the real WebSocket exposes both static and instance).
  readonly CONNECTING = FakeWebSocket.CONNECTING
  readonly OPEN = FakeWebSocket.OPEN
  readonly CLOSING = FakeWebSocket.CLOSING
  readonly CLOSED = FakeWebSocket.CLOSED

  url: string
  readyState: number = FakeWebSocket.CONNECTING

  /** Raw frames passed to send(), in order. */
  sent: string[] = []
  /** Every close() invocation by the transport, with its args. */
  closeCalls: Array<{ code?: number; reason?: string }> = []

  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: FakeCloseEvent) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  // --- WebSocket API surface used by WsTransport ---

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error(`FakeWebSocket: send() while readyState=${this.readyState} (not OPEN)`)
    }
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
    this.readyState = FakeWebSocket.CLOSED
  }

  // --- Test drivers ---

  /** Parsed view of every frame sent, for payload assertions. */
  sentJson(): any[] {
    return this.sent.map((s) => JSON.parse(s))
  }

  /** Parsed view of the most recent frame sent. */
  lastSent(): any {
    if (this.sent.length === 0) throw new Error('FakeWebSocket.lastSent(): nothing was sent')
    return JSON.parse(this.sent[this.sent.length - 1]!)
  }

  /** Server accepted the connection — fires onopen. */
  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.({})
  }

  /** Server pushed a frame — fires onmessage with the serialized payload. */
  simulateMessage(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) })
  }

  /** Server (or network) closed the connection — fires onclose. Default code is
   *  1006 (abnormal closure), the real code for a dropped connection. */
  simulateServerClose(code = 1006, reason = '', wasClean = false): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason, wasClean })
  }

  /** Transport-level error event — fires onerror. */
  simulateError(message = 'socket error'): void {
    this.onerror?.({ message })
  }
}
