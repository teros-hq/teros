/**
 * StreamConnection — one window's socket to the MCA streams data plane
 * (spec docs/specs/20261104_mca-streams.md, MCS-REQ-9).
 *
 * Frames never transit the app's main WebSocket: the window asks the main
 * socket for a ticket (`stream.ticket`), opens its own connection to
 * `/ws/stream`, attaches its stream and relays frames and state to the
 * caller. Reconnects with backoff and a fresh ticket; `attach` is replayed
 * on reconnect so a blip never loses the stream (the MCA keeps it).
 * Nothing kind-specific lives here: the browser tab, a terminal, a screen
 * share all use this class.
 */

import { decodeViewerFrame, type StreamRelayMessage, type TicketResponse } from "./streamProtocol"

export interface StreamHandlers {
  /** A binary frame of the stream. */
  frame(id: string, kind: number, payload: Uint8Array): void
  attached(
    id: string,
    kind: string,
    state: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): void
  state(id: string, state: Record<string, unknown>): void
  closed(id: string, reason: string): void
  error(code: string, msg: string | undefined, id?: string): void
  status(conn: "connecting" | "live" | "offline" | "unavailable"): void
}

export interface AttachParams {
  id: string
  meta?: Record<string, unknown>
}

const PING_MS = 15_000
const MAX_BACKOFF_MS = 10_000

/** Minimal WebSocket surface (so tests can inject a fake). */
export interface WebSocketLike {
  binaryType: string
  readyState: number
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export interface StreamConnectionOptions {
  /** `stream.ticket` on the main socket; rejects when streams are unavailable. */
  getTicket(): Promise<TicketResponse>
  /** ws(s)://host of the backend the app talks to. */
  wsBase(): string
  makeSocket?(url: string): WebSocketLike
  now?(): number
}

export class StreamConnection {
  private ws: WebSocketLike | null = null
  private backoff = 500
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private closedForGood = false
  private opening = false
  private attach: AttachParams | null = null
  rttMs: number | null = null

  constructor(
    private readonly handlers: StreamHandlers,
    private readonly options: StreamConnectionOptions,
  ) {}

  /** Open (ticket → socket). Idempotent while a socket is open or opening. */
  open(): void {
    if (this.closedForGood || this.ws || this.opening) return
    this.opening = true
    this.handlers.status("connecting")
    this.options
      .getTicket()
      .then((res) => {
        this.opening = false
        if (this.closedForGood) return
        this.connect(res)
      })
      .catch((err: unknown) => {
        this.opening = false
        if (this.closedForGood) return
        const code = errorCode(err)
        if (code === "STREAMS_UNAVAILABLE" || code === "FORBIDDEN" || code === "UNKNOWN_ACTION") {
          this.handlers.status("unavailable")
          this.handlers.error(code, errorMessage(err))
          return
        }
        this.handlers.status("offline")
        this.handlers.error(code ?? "TICKET_FAILED", errorMessage(err))
        this.scheduleReconnect()
      })
  }

  private connect(res: TicketResponse): void {
    const url = `${this.options.wsBase()}${res.path || "/ws/stream"}?ticket=${encodeURIComponent(res.ticket)}`
    const make =
      this.options.makeSocket ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike)
    const ws = make(url)
    ws.binaryType = "arraybuffer"
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 500
      this.handlers.status("live")
      if (this.attach) this.send({ t: "attach", ...this.attach })
      this.startPing()
    }
    ws.onmessage = (event) => {
      const data = event.data
      if (typeof data === "string") {
        let msg: StreamRelayMessage
        try {
          msg = JSON.parse(data) as StreamRelayMessage
        } catch {
          return
        }
        this.text(msg)
        return
      }
      if (data instanceof ArrayBuffer) {
        const frame = decodeViewerFrame(data)
        if (frame) this.handlers.frame(frame.id, frame.kind, frame.payload)
      }
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

  private text(msg: StreamRelayMessage): void {
    switch (msg.t) {
      case "attached":
        this.handlers.attached(msg.id, msg.kind, msg.state, msg.meta)
        return
      case "state":
        this.handlers.state(msg.id, msg.state)
        return
      case "closed":
        this.handlers.closed(msg.id, msg.reason)
        return
      case "err":
        this.handlers.error(msg.code, msg.msg, msg.id)
        return
      case "pong":
        if (typeof msg.c === "number")
          this.rttMs = Math.round((this.options.now?.() ?? Date.now()) - msg.c)
        return
      default:
        return
    }
  }

  private scheduleReconnect(): void {
    if (this.retryTimer || this.closedForGood) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, delay)
  }

  /** Reconnect now if the socket is down (tab visible again, network back). */
  wake(): void {
    if (this.closedForGood || this.ws || this.opening) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.backoff = 500
    this.open()
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(
      () => this.send({ t: "ping", c: this.options.now?.() ?? Date.now() }),
      PING_MS,
    )
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  get live(): boolean {
    return this.ws !== null && this.ws.readyState === 1
  }

  send(msg: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false
    try {
      this.ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  /** Attach (now, or as soon as the socket opens; replayed on reconnect). */
  attachStream(params: AttachParams): void {
    this.attach = params
    this.send({ t: "attach", ...params })
  }

  /** Update the meta the relay reports to the MCA (size, dpr…) — resent with the next attach. */
  setMeta(meta: Record<string, unknown>): void {
    if (this.attach) this.attach = { ...this.attach, meta }
  }

  /** Send an input frame for the attached stream (opaque to the relay). */
  input(input: Record<string, unknown>): boolean {
    if (!this.attach) return false
    return this.send({ t: "in", id: this.attach.id, ...input })
  }

  /** Stop viewing and close the socket. */
  dispose(): void {
    this.closedForGood = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.stopPing()
    if (this.attach) this.send({ t: "detach", id: this.attach.id })
    this.ws?.close()
    this.ws = null
  }
}

function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null) {
    const e = err as { code?: unknown; error?: { code?: unknown } }
    if (typeof e.code === "string") return e.code
    if (typeof e.error?.code === "string") return e.error.code
  }
  if (err instanceof Error && /STREAMS_UNAVAILABLE/.test(err.message)) return "STREAMS_UNAVAILABLE"
  return undefined
}

function errorMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message
  if (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message
  }
  return undefined
}
