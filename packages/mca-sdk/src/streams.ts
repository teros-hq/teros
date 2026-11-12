/**
 * MCA streams — the SDK side (spec docs/specs/20261104_mca-streams.md, MCS-REQ-5).
 *
 * An MCA with `layers.streams` opens streams on its backend WebSocket:
 *
 *   const streams = new McaStreams(wsClient)
 *   const s = streams.open({ streamId: 'browser-tab:win1', kind: 'browser-tab',
 *                            scope: { userId, workspaceId }, state: { url } })
 *   s.on('viewers', (list) => …)         // who is watching (empty = nobody)
 *   s.on('input', (viewerId, userId, input) => …)
 *   s.send(1, jpegBytes)                  // binary frame, dropped when the socket is full
 *   s.setState({ url, title })            // JSON state, relayed to viewers
 *   s.close('done')
 *
 * Streams survive a reconnect: when the client connects again every open
 * stream is re-announced with its last state.
 */

import { EventEmitter } from "node:events"
import {
  encodeStreamFrame,
  STREAM_FRAME_MAX_BYTES,
  STREAM_SDK_BUFFER_CAP,
  type StreamScope,
  type StreamViewer,
  type WsStreamError,
  type WsStreamInput,
  type WsStreamViewers,
} from "@teros/shared"
export type { StreamScope, StreamViewer } from "@teros/shared"

export interface StreamOpenOptions {
  streamId: string
  kind: string
  scope: StreamScope
  state?: Record<string, unknown>
  meta?: Record<string, unknown>
}

export interface McaStreamEvents {
  viewers: (viewers: StreamViewer[]) => void
  input: (viewerId: string, userId: string, input: Record<string, unknown>) => void
  /** The backend refused the stream (STREAMS_NOT_DECLARED, STREAM_LIMIT). Not `error`: an unhandled EventEmitter error would crash the MCA. */
  rejected: (code: string, message?: string) => void
  closed: (reason: string) => void
}

export class McaStream extends EventEmitter {
  readonly id: string
  readonly kind: string
  readonly scope: StreamScope
  state: Record<string, unknown>
  meta: Record<string, unknown>
  viewers: StreamViewer[] = []
  private closedReason: string | null = null
  /** Frames dropped because the socket was closed or over the buffered cap. */
  dropped = 0

  constructor(
    private readonly owner: McaStreams,
    opts: StreamOpenOptions,
  ) {
    super()
    this.id = opts.streamId
    this.kind = opts.kind
    this.scope = opts.scope
    this.state = opts.state ?? {}
    this.meta = opts.meta ?? {}
  }

  on<K extends keyof McaStreamEvents>(event: K, listener: McaStreamEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  get closed(): boolean {
    return this.closedReason !== null
  }

  get hasViewers(): boolean {
    return this.viewers.length > 0
  }

  /** Push a binary frame. False when dropped (closed stream, closed socket, socket over the cap). */
  send(kind: number, payload: Uint8Array): boolean {
    if (this.closedReason) return false
    if (payload.length > STREAM_FRAME_MAX_BYTES) {
      this.dropped++
      return false
    }
    const ok = this.owner.sendFrame(encodeStreamFrame(this.id, kind, payload))
    if (!ok) this.dropped++
    return ok
  }

  /** Replace the stream's state (relayed to every viewer; re-announced on reconnect). */
  setState(state: Record<string, unknown>): void {
    if (this.closedReason) return
    this.state = state
    this.owner.sendControl({ type: "stream_state", streamId: this.id, state })
  }

  close(reason = "closed"): void {
    if (this.closedReason) return
    this.closedReason = reason
    this.owner.sendControl({ type: "stream_close", streamId: this.id, reason })
    this.owner.forget(this.id)
    this.emit("closed", reason)
    this.removeAllListeners()
  }

  /** @internal */
  _viewers(list: StreamViewer[]): void {
    this.viewers = list
    this.emit("viewers", list)
  }

  /** @internal */
  _input(msg: WsStreamInput): void {
    this.emit("input", msg.viewerId, msg.userId, msg.input)
  }

  /** @internal */
  _error(msg: WsStreamError): void {
    this.emit("rejected", msg.code, msg.message)
  }

  /** @internal — the socket closed; the stream is kept and re-announced on reconnect. */
  _announce(): void {
    if (this.closedReason) return
    this.owner.sendControl({
      type: "stream_open",
      streamId: this.id,
      kind: this.kind,
      scope: this.scope,
      state: this.state,
      meta: this.meta,
    })
  }
}

/** The socket surface McaStreams needs (McaWebSocketClient implements it; tests fake it). */
export interface StreamSocket {
  sendRaw(message: Record<string, unknown>): boolean
  sendBinary(data: Uint8Array): boolean
  bufferedAmount(): number
  on(event: "connected", listener: () => void): unknown
  on(event: "stream_viewers", listener: (m: WsStreamViewers) => void): unknown
  on(event: "stream_input", listener: (m: WsStreamInput) => void): unknown
  on(event: "stream_error", listener: (m: WsStreamError) => void): unknown
}

export class McaStreams {
  private streams = new Map<string, McaStream>()

  constructor(private readonly socket: StreamSocket) {
    socket.on("connected", () => {
      for (const s of this.streams.values()) s._announce()
    })
    socket.on("stream_viewers", (m) => this.streams.get(m.streamId)?._viewers(m.viewers))
    socket.on("stream_input", (m) => this.streams.get(m.streamId)?._input(m))
    socket.on("stream_error", (m) => this.streams.get(m.streamId)?._error(m))
  }

  /** Open (or re-declare) a stream. The same id returns the existing stream with the new state. */
  open(opts: StreamOpenOptions): McaStream {
    const existing = this.streams.get(opts.streamId)
    if (existing && !existing.closed) {
      if (opts.state) existing.state = opts.state
      if (opts.meta) existing.meta = opts.meta
      existing._announce()
      return existing
    }
    const stream = new McaStream(this, opts)
    this.streams.set(opts.streamId, stream)
    stream._announce()
    return stream
  }

  get(streamId: string): McaStream | undefined {
    const s = this.streams.get(streamId)
    return s && !s.closed ? s : undefined
  }

  list(): McaStream[] {
    return [...this.streams.values()].filter((s) => !s.closed)
  }

  closeAll(reason = "shutdown"): void {
    for (const s of [...this.streams.values()]) s.close(reason)
  }

  /** @internal */
  forget(streamId: string): void {
    this.streams.delete(streamId)
  }

  /** @internal */
  sendControl(message: Record<string, unknown>): boolean {
    return this.socket.sendRaw(message)
  }

  /** @internal */
  sendFrame(frame: Uint8Array): boolean {
    if (this.socket.bufferedAmount() > STREAM_SDK_BUFFER_CAP) return false
    return this.socket.sendBinary(frame)
  }
}
