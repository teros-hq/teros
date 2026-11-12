/**
 * MCA stream relay — MCA streams between an MCA's socket and the people
 * watching (spec docs/specs/20261104_mca-streams.md, MCS-REQ-3/4/6/7/8).
 *
 * The MCA announces streams on its `/mca` socket (`stream_open`, state,
 * close) and pushes binary frames there; this relay keeps the registry,
 * mints single-use tickets for the stream's user, serves viewers on
 * `/ws/stream` (the terminal data plane's model: a socket per view, binary
 * frames down, JSON control up, a buffer cap per viewer so a slow one
 * skips frames instead of queueing) and turns the viewers' `in` frames
 * into `stream_input` for the MCA. Frames and input are opaque to it.
 */

import { randomBytes } from "node:crypto"
import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import {
  decodeStreamFrame,
  encodeViewerFrame,
  STREAM_FRAME_MAX_BYTES,
  STREAM_TICKET_TTL_MS,
  STREAM_VIEWER_BUFFER_CAP,
  STREAMS_PER_APP_MAX,
  type StreamRelayMessage,
  type StreamScope,
  type StreamViewer,
  type WsBackendToMcaMessage,
  type WsStreamClose,
  type WsStreamOpen,
  type WsStreamState,
} from "@teros/shared"
import type { Db } from "mongodb"
import { WebSocket, WebSocketServer } from "ws"
import { canWriteWorkspace } from "../auth/workspace-access"

/** A viewer silent this long is gone (the client pings every 15 s). */
const VIEWER_SILENCE_MS = 150_000

interface Ticket {
  userId: string
  expires: number
}

export interface RelayStream {
  streamId: string
  appId: string
  kind: string
  scope: StreamScope
  state: Record<string, unknown>
  meta: Record<string, unknown>
  viewers: Set<Viewer>
  openedAt: number
}

interface Viewer {
  viewerId: string
  ws: WebSocket
  userId: string
  lastSeen: number
  /** streamId → the meta the viewer attached with (size, dpr…). */
  attached: Map<string, Record<string, unknown>>
}

export interface McaStreamRelayStats {
  streams: number
  viewers: number
  framesIn: number
  framesOut: number
  framesSkipped: number
  inputs: number
}

export interface McaStreamRelayOptions {
  /** Send a control message to an MCA's socket (McaConnectionManager.send). */
  sendToMca: (appId: string, message: WsBackendToMcaMessage) => boolean
  /** Whether the MCA behind `appId` declares `layers.streams` (MCS-REQ-1). */
  declaresStreams: (appId: string) => Promise<boolean>
  /** Workspace write check (default canWriteWorkspace on the Db). Injectable for tests. */
  canWrite?: (userId: string, workspaceId: string) => Promise<boolean>
  now?: () => number
  log?: (msg: string) => void
}

export class McaStreamRelay {
  private wss: WebSocketServer | null = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
  })
  private tickets = new Map<string, Ticket>()
  private viewers = new Set<Viewer>()
  private streams = new Map<string, RelayStream>()
  private byApp = new Map<string, Set<string>>()
  private readonly reaper: ReturnType<typeof setInterval>
  private readonly now: () => number
  private readonly log: (msg: string) => void
  readonly stats: McaStreamRelayStats = {
    streams: 0,
    viewers: 0,
    framesIn: 0,
    framesOut: 0,
    framesSkipped: 0,
    inputs: 0,
  }

  constructor(
    private readonly db: Db,
    private readonly options: McaStreamRelayOptions,
  ) {
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? ((m) => console.log(m))
    this.reaper = setInterval(() => {
      const cutoff = this.now() - VIEWER_SILENCE_MS
      for (const v of this.viewers) if (v.lastSeen < cutoff) v.ws.terminate()
    }, VIEWER_SILENCE_MS / 3)
    this.reaper.unref?.()
    this.wss?.on("connection", (ws: WebSocket, req: IncomingMessage) => this.connection(ws, req))
  }

  // ── MCA side (called by McaConnectionManager) ──────────────────────────────

  /** @spec MCS-REQ-2 / MCS-REQ-1 */
  async open(appId: string, msg: WsStreamOpen): Promise<void> {
    if (!(await this.options.declaresStreams(appId))) {
      this.options.sendToMca(appId, {
        type: "stream_error",
        streamId: msg.streamId,
        code: "STREAMS_NOT_DECLARED",
        message: "This MCA's manifest does not declare layers.streams",
      })
      return
    }
    const existing = this.streams.get(msg.streamId)
    if (existing && existing.appId !== appId) {
      // Ids are per app: another app's stream with the same id is not touched.
      this.options.sendToMca(appId, {
        type: "stream_error",
        streamId: msg.streamId,
        code: "STREAM_LIMIT",
        message: "stream id in use",
      })
      return
    }
    if (existing) {
      existing.kind = msg.kind
      existing.scope = msg.scope
      existing.state = msg.state ?? existing.state
      existing.meta = msg.meta ?? existing.meta
      for (const v of existing.viewers)
        this.sendText(v, { t: "state", id: existing.streamId, state: existing.state })
      // The MCA may have reconnected: tell it who is still watching.
      this.notifyViewers(existing)
      return
    }
    const mine = this.byApp.get(appId) ?? new Set<string>()
    if (mine.size >= STREAMS_PER_APP_MAX) {
      this.options.sendToMca(appId, {
        type: "stream_error",
        streamId: msg.streamId,
        code: "STREAM_LIMIT",
        message: `at most ${STREAMS_PER_APP_MAX} streams per app`,
      })
      return
    }
    const stream: RelayStream = {
      streamId: msg.streamId,
      appId,
      kind: msg.kind,
      scope: msg.scope,
      state: msg.state ?? {},
      meta: msg.meta ?? {},
      viewers: new Set(),
      openedAt: this.now(),
    }
    this.streams.set(stream.streamId, stream)
    mine.add(stream.streamId)
    this.byApp.set(appId, mine)
    this.stats.streams = this.streams.size
  }

  state(appId: string, msg: WsStreamState): void {
    const stream = this.streams.get(msg.streamId)
    if (!stream || stream.appId !== appId) return
    stream.state = msg.state
    for (const v of stream.viewers)
      this.sendText(v, { t: "state", id: stream.streamId, state: msg.state })
  }

  close(appId: string, msg: WsStreamClose): void {
    const stream = this.streams.get(msg.streamId)
    if (!stream || stream.appId !== appId) return
    this.drop(stream, msg.reason ?? "closed")
  }

  /** @spec MCS-REQ-3 — a binary frame from an MCA: route to the stream's viewers. */
  frame(appId: string, data: Uint8Array): void {
    this.stats.framesIn++
    if (data.length > STREAM_FRAME_MAX_BYTES + 260) return
    const frame = decodeStreamFrame(data)
    if (!frame) return
    const stream = this.streams.get(frame.id)
    if (!stream || stream.appId !== appId || stream.viewers.size === 0) return
    const out = encodeViewerFrame(frame.id, frame.kind, frame.payload)
    for (const v of stream.viewers) {
      if (v.ws.readyState !== WebSocket.OPEN) continue
      if (v.ws.bufferedAmount > STREAM_VIEWER_BUFFER_CAP) {
        this.stats.framesSkipped++
        continue
      }
      this.stats.framesOut++
      v.ws.send(out, { binary: true })
    }
  }

  /** The MCA's socket went away: every stream of it is over for its viewers. */
  closeApp(appId: string, reason = "mca_disconnected"): void {
    for (const id of [...(this.byApp.get(appId) ?? [])]) {
      const stream = this.streams.get(id)
      if (stream) this.drop(stream, reason)
    }
  }

  describe(streamId: string): RelayStream | null {
    return this.streams.get(streamId) ?? null
  }

  // ── Viewer side ────────────────────────────────────────────────────────────

  /** @spec MCS-REQ-7 */
  issueTicket(userId: string): string {
    const now = this.now()
    for (const [k, t] of this.tickets) if (t.expires < now) this.tickets.delete(k)
    const ticket = randomBytes(24).toString("base64url")
    this.tickets.set(ticket, { userId, expires: now + STREAM_TICKET_TTL_MS })
    return ticket
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "", "http://localhost")
    const key = url.searchParams.get("ticket") ?? ""
    const ticket = this.tickets.get(key)
    if (ticket) this.tickets.delete(key)
    if (!this.wss || !ticket || ticket.expires < this.now()) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }
    ;(request as IncomingMessage & { terosTicket?: Ticket }).terosTicket = ticket
    this.wss.handleUpgrade(request, socket, head, (ws) => this.wss?.emit("connection", ws, request))
  }

  async shutdown(): Promise<void> {
    clearInterval(this.reaper)
    const wss = this.wss
    this.wss = null
    for (const v of this.viewers) v.ws.terminate()
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()))
  }

  private connection(ws: WebSocket, req: IncomingMessage): void {
    const ticket = (req as IncomingMessage & { terosTicket?: Ticket }).terosTicket
    if (!ticket) {
      ws.close(4401, "unauthorized")
      return
    }
    const viewer: Viewer = {
      viewerId: randomBytes(8).toString("base64url"),
      ws,
      userId: ticket.userId,
      lastSeen: this.now(),
      attached: new Map(),
    }
    this.viewers.add(viewer)
    this.stats.viewers = this.viewers.size
    ws.on("message", (raw, isBinary) => {
      viewer.lastSeen = this.now()
      if (isBinary) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      this.message(viewer, msg).catch((err) =>
        this.sendText(viewer, {
          t: "err",
          id: String(msg.id ?? ""),
          code: "INTERNAL",
          msg: String(err),
        }),
      )
    })
    ws.on("close", () => {
      for (const id of [...viewer.attached.keys()]) this.detach(viewer, id)
      this.viewers.delete(viewer)
      this.stats.viewers = this.viewers.size
    })
    ws.on("error", () => {})
  }

  /** Exposed for tests: one client frame as if it came over the socket. */
  async message(viewer: Viewer, msg: Record<string, unknown>): Promise<void> {
    const id = typeof msg.id === "string" ? msg.id.slice(0, 200) : ""
    switch (msg.t) {
      case "ping":
        this.sendText(viewer, { t: "pong", c: Number(msg.c), s: this.now() })
        return
      case "attach":
        await this.attach(viewer, id, msg.meta)
        return
      case "detach":
        this.detach(viewer, id)
        return
      case "in": {
        // @spec MCS-REQ-4 — opaque input to the MCA, stamped with who sent it.
        const stream = this.streams.get(id)
        if (!stream || !viewer.attached.has(id)) return
        const { t: _t, id: _id, ...input } = msg
        this.stats.inputs++
        this.options.sendToMca(stream.appId, {
          type: "stream_input",
          streamId: stream.streamId,
          viewerId: viewer.viewerId,
          userId: viewer.userId,
          input,
        })
        return
      }
      default:
        return
    }
  }

  /** @spec MCS-REQ-8 */
  private async attach(viewer: Viewer, id: string, meta: unknown): Promise<void> {
    if (!id) {
      this.sendText(viewer, { t: "err", id, code: "BAD_ATTACH", msg: "id is required" })
      return
    }
    const stream = this.streams.get(id)
    if (!stream) {
      this.sendText(viewer, {
        t: "err",
        id,
        code: "STREAM_NOT_FOUND",
        msg: "No such stream (not opened, or closed)",
      })
      return
    }
    if (stream.scope.userId !== viewer.userId) {
      this.sendText(viewer, {
        t: "err",
        id,
        code: "FORBIDDEN_STREAM",
        msg: "This stream belongs to someone else",
      })
      return
    }
    const canWrite =
      this.options.canWrite ?? ((u: string, w: string) => canWriteWorkspace(this.db, u, w))
    if (!(await canWrite(viewer.userId, stream.scope.workspaceId))) {
      this.sendText(viewer, {
        t: "err",
        id,
        code: "FORBIDDEN_WORKSPACE_ROLE",
        msg: "Write access to the workspace is required",
      })
      return
    }
    const viewerMeta =
      typeof meta === "object" && meta !== null && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : {}
    viewer.attached.set(id, viewerMeta)
    stream.viewers.add(viewer)
    this.sendText(viewer, {
      t: "attached",
      id,
      kind: stream.kind,
      state: stream.state,
      meta: stream.meta,
    })
    this.notifyViewers(stream)
  }

  private detach(viewer: Viewer, id: string): void {
    if (!viewer.attached.delete(id)) return
    const stream = this.streams.get(id)
    if (!stream) return
    stream.viewers.delete(viewer)
    this.notifyViewers(stream)
  }

  private notifyViewers(stream: RelayStream): void {
    const viewers: StreamViewer[] = [...stream.viewers].map((v) => ({
      viewerId: v.viewerId,
      userId: v.userId,
      meta: v.attached.get(stream.streamId) ?? {},
    }))
    this.options.sendToMca(stream.appId, {
      type: "stream_viewers",
      streamId: stream.streamId,
      viewers,
    })
  }

  private drop(stream: RelayStream, reason: string): void {
    for (const v of stream.viewers) {
      v.attached.delete(stream.streamId)
      this.sendText(v, { t: "closed", id: stream.streamId, reason })
    }
    stream.viewers.clear()
    this.streams.delete(stream.streamId)
    this.byApp.get(stream.appId)?.delete(stream.streamId)
    this.stats.streams = this.streams.size
  }

  private sendText(viewer: Viewer, msg: StreamRelayMessage): void {
    if (viewer.ws.readyState !== WebSocket.OPEN) return
    try {
      viewer.ws.send(JSON.stringify(msg))
    } catch {
      /* closing */
    }
  }
}
