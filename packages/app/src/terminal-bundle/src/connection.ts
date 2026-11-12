/**
 * The page's own connection to /ws/terminal: output never transits the app's
 * main WebSocket nor a postMessage hop. Tickets come from the window (it holds
 * the session), one per connection; reconnects ask for a fresh one.
 *
 * Flow control: every rendered output byte is acked (batched), so the server
 * knows how far behind this tab is and switches it to a snapshot instead of
 * a backlog when it falls behind.
 *
 * Latency: keystroke→echo time (time from sending input to the next output
 * frame, which for typing is the echo) and WS round trip (ping/pong).
 */

import { type BinaryFrame, decodeFrame } from "./protocol"

export interface ConnectionHandlers {
  frame(frame: BinaryFrame): void
  text(msg: Record<string, unknown>): void
  status(conn: "connecting" | "live" | "offline"): void
  needTicket(): void
}

const ACK_BYTES = 32 * 1024
const ACK_MS = 30
const PING_MS = 15_000
const ECHO_WINDOW = 200

export class TerminalConnection {
  private ws: WebSocket | null = null
  private wsUrl = ""
  private backoff = 500
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private ackPending = 0
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  private attachedId: string | null = null
  private size = { cols: 80, rows: 24 }
  private closedForGood = false
  private waitingTicket = false
  private probeAt: number | null = null
  private echoes: number[] = []
  rttMs: number | null = null
  bytesIn = 0

  constructor(private readonly handlers: ConnectionHandlers) {}

  configure(wsUrl: string): void {
    this.wsUrl = wsUrl
  }

  /** Open with a ticket from the window. */
  open(ticket: string): void {
    this.waitingTicket = false
    if (this.closedForGood || !this.wsUrl) return
    this.ws?.close()
    const sep = this.wsUrl.includes("?") ? "&" : "?"
    const ws = new WebSocket(`${this.wsUrl}${sep}ticket=${encodeURIComponent(ticket)}`)
    ws.binaryType = "arraybuffer"
    this.ws = ws
    this.handlers.status("connecting")
    ws.onopen = () => {
      this.backoff = 500
      this.handlers.status("live")
      if (this.attachedId) this.sendAttach()
      this.startPing()
    }
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        if (msg.t === "pong" && typeof msg.c === "number")
          this.rttMs = Math.round(performance.now() - msg.c)
        this.handlers.text(msg)
        return
      }
      const frame = decodeFrame(event.data as ArrayBuffer)
      if (!frame) return
      this.bytesIn += frame.payload.length
      if (this.probeAt !== null && frame.kind === 1) {
        this.echoes.push(performance.now() - this.probeAt)
        if (this.echoes.length > ECHO_WINDOW) this.echoes.shift()
        this.probeAt = null
      }
      this.handlers.frame(frame)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.stopPing()
      if (this.closedForGood) return
      this.handlers.status("offline")
      this.scheduleReconnect()
    }
    ws.onerror = () => {}
  }

  /** Reconnect now if the socket is down (tab visible again, network back). */
  wake(): void {
    if (this.closedForGood || this.ws || this.waitingTicket) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.backoff = 500
    this.requestTicket()
  }

  private scheduleReconnect(): void {
    if (this.retryTimer) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, 10_000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.requestTicket()
    }, delay)
  }

  private requestTicket(): void {
    this.waitingTicket = true
    this.handlers.needTicket()
  }

  attach(terminalId: string, cols: number, rows: number): void {
    if (this.attachedId && this.attachedId !== terminalId)
      this.sendJson({ t: "detach", id: this.attachedId })
    this.attachedId = terminalId
    this.size = { cols, rows }
    this.ackPending = 0
    this.sendAttach()
  }

  /** Attach again to the current session (it didn't exist yet: a create still in flight). */
  reattach(): void {
    this.sendAttach()
  }

  private sendAttach(): void {
    if (this.attachedId) this.sendJson({ t: "attach", id: this.attachedId, ...this.size })
  }

  input(data: string): void {
    if (!this.attachedId) return
    if (this.probeAt === null) this.probeAt = performance.now()
    this.sendJson({ t: "in", id: this.attachedId, d: data })
  }

  resize(cols: number, rows: number): void {
    if (cols === this.size.cols && rows === this.size.rows) return
    this.size = { cols, rows }
    if (this.attachedId) this.sendJson({ t: "resize", id: this.attachedId, cols, rows })
  }

  /** `bytes` of output were rendered (xterm write callback). */
  rendered(bytes: number): void {
    this.ackPending += bytes
    if (this.ackPending >= ACK_BYTES) this.flushAck()
    else if (!this.ackTimer) this.ackTimer = setTimeout(() => this.flushAck(), ACK_MS)
  }

  private flushAck(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
    if (!this.ackPending || !this.attachedId) return
    this.sendJson({ t: "ack", id: this.attachedId, n: this.ackPending })
    this.ackPending = 0
  }

  /** The session ended: stop reconnecting. */
  end(): void {
    this.closedForGood = true
    this.stopPing()
    this.ws?.close()
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  echoStats(): { p50: number | null; p95: number | null } {
    if (!this.echoes.length) return { p50: null, p95: null }
    const sorted = [...this.echoes].sort((a, b) => a - b)
    const at = (q: number) =>
      Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))])
    return { p50: at(0.5), p95: at(0.95) }
  }

  private startPing(): void {
    this.stopPing()
    const ping = () => this.sendJson({ t: "ping", c: performance.now() })
    ping()
    this.pingTimer = setInterval(ping, PING_MS)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private sendJson(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }
}
