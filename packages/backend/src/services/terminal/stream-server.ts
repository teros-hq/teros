/**
 * /ws/terminal — the terminal data plane.
 *
 * The control plane (create, list, pin, destroy…) stays on the main WS as
 * terminal.* actions; the bytes of live sessions travel here, on a socket per
 * terminal view, so a flood of output never queues behind (or in front of)
 * the app's other traffic.
 *
 * Auth: a single-use ticket minted by `terminal.ticket` on the main WS (60 s),
 * then every attach re-checks access (terminal-access.ts: write members only).
 *
 * Attaching to a frozen or sleeping session wakes it first ('attached' says
 * `woke`: "frozen" | "sleeping" | null); a session that can't be woken gets
 * err TERMINAL_WAKE_FAILED.
 *
 * Frames
 *   client → server (JSON text)
 *     { t:'attach', id, cols, rows }   start watching; replies 'attached' + a snapshot
 *     { t:'detach', id }
 *     { t:'in', id, d }                keystrokes (read-only while someone
 *                                      else holds the wheel → err WHEEL_HELD)
 *     { t:'resize', id, cols, rows }   the viewer's fitted size
 *     { t:'ack', id, n }               n bytes of output were rendered (flow control)
 *     { t:'ping', c }                  → { t:'pong', c }   (latency probe)
 *   server → client
 *     binary: [kind u8][idLen u8][id utf8][payload utf8]; kind 1 = output, 2 = snapshot
 *     JSON:   attached · size · state · exit · err · pong
 *
 * Flow control: output is batched per viewer (8 ms or 64 KiB) and counted
 * until acked. A viewer more than HIGH_WATER bytes behind stops receiving
 * output; once it has caught up (LOW_WATER) it gets a fresh snapshot instead
 * of the backlog — `yes | head -c 200M` costs the browser a few redraws, not
 * 200 MB. The snapshot's sequence number splices it exactly into the stream.
 *
 * Size: the pane has one size. The writer who attached or typed last drives
 * it ("latest", like tmux); everyone else gets `size` and fits their xterm
 * to the pane.
 */

import type { Principal, TerminalWatcher } from "@teros/shared"
import { randomBytes } from "crypto"
import type { IncomingMessage } from "http"
import type { Db } from "mongodb"
import type { Duplex } from "stream"
import { WebSocket, WebSocketServer } from "ws"
import type { PtyManager, SessionInfo } from "../pty-manager"
import { checkTerminalAccess, mayReachSession, terminalPrincipal } from "./terminal-access"

const TICKET_TTL_MS = 60_000
const BATCH_MS = 8
const BATCH_MAX_BYTES = 64 * 1024
/** A viewer this far behind (unacked bytes) stops receiving output until it catches up. */
const HIGH_WATER = 1024 * 1024
const LOW_WATER = 128 * 1024
/** Socket-level guard: never queue more than this in `ws` for one viewer. */
const MAX_BUFFERED = 4 * 1024 * 1024
/** Screen frames per second while a session floods (4/s: smooth enough, nearly free). */
const FLOOD_FRAME_MS = 250
/** A viewer silent this long is gone (pings every 15 s; hidden tabs may be throttled to 1/min). */
const VIEWER_SILENCE_MS = 150_000
const MIN_COLS = 10
const MIN_ROWS = 3
const MAX_COLS = 500
const MAX_ROWS = 200

const KIND_OUTPUT = 1
const KIND_SNAPSHOT = 2

interface Ticket {
  userId: string
  name: string
  avatarUrl: string | null
  expires: number
}

/** One viewer's view of one session. */
interface Attachment {
  terminalId: string
  unsubscribe: () => void
  /** Output waiting for the next batch flush. */
  pending: string[]
  pendingBytes: number
  timer: ReturnType<typeof setTimeout> | null
  /** Screen frames while the session floods. */
  floodTimer: ReturnType<typeof setInterval> | null
  /** When the last frame went out (leading-edge flush for interactive echo). */
  lastFlushAt: number
  unacked: number
  /** Behind: output is dropped until acks bring it under LOW_WATER, then a snapshot resyncs it. */
  stale: boolean
  /** A snapshot is being fetched: buffer output (with its sequence number) until it lands. */
  syncing: Array<{ data: string; seq: number }> | null
  cols: number
  rows: number
  principal: Principal
}

interface Viewer {
  /** Last message from the page (it pings every 15 s). */
  lastSeen: number
  ws: WebSocket
  userId: string
  name: string
  avatarUrl: string | null
  attachments: Map<string, Attachment>
}

export interface TerminalStreamStats {
  viewers: number
  attachments: number
  bytesOut: number
  snapshots: number
  resyncs: number
}

export class TerminalStreamServer {
  private wss: WebSocketServer | null = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  })
  private tickets = new Map<string, Ticket>()
  private viewers = new Set<Viewer>()
  /** terminalId → viewers attached to it. */
  private byTerminal = new Map<string, Set<Viewer>>()
  readonly stats: TerminalStreamStats = {
    viewers: 0,
    attachments: 0,
    bytesOut: 0,
    snapshots: 0,
    resyncs: 0,
  }

  /** Drops viewers whose socket died without a close (sleeping laptop, killed tab). */
  private reaper: ReturnType<typeof setInterval>

  constructor(
    private readonly db: Db,
    private readonly ptyManager: PtyManager,
  ) {
    this.reaper = setInterval(() => {
      const cutoff = Date.now() - VIEWER_SILENCE_MS
      for (const v of this.viewers) if (v.lastSeen < cutoff) v.ws.terminate()
    }, VIEWER_SILENCE_MS / 3)
    this.reaper.unref?.()
    this.wss?.on("connection", (ws: WebSocket, req: IncomingMessage) => this.connection(ws, req))
  }

  /** Mint a single-use ticket for the data plane (terminal.ticket): who the viewer is, as the seat shows them. */
  issueTicket(userId: string, name: string, avatarUrl: string | null = null): string {
    const now = Date.now()
    for (const [k, t] of this.tickets) if (t.expires < now) this.tickets.delete(k)
    const ticket = randomBytes(24).toString("base64url")
    this.tickets.set(ticket, { userId, name, avatarUrl, expires: now + TICKET_TTL_MS })
    return ticket
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? "", "http://localhost")
    const ticket = this.tickets.get(url.searchParams.get("ticket") ?? "")
    if (ticket) this.tickets.delete(url.searchParams.get("ticket") ?? "")
    if (!this.wss || !ticket || ticket.expires < Date.now()) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }
    ;(request as IncomingMessage & { terosTicket?: Ticket }).terosTicket = ticket
    this.wss.handleUpgrade(request, socket, head, (ws) => this.wss?.emit("connection", ws, request))
  }

  viewerCount(terminalId: string): number {
    return this.byTerminal.get(terminalId)?.size ?? 0
  }

  /**
   * Who watches a session: the people with it open (one entry per person,
   * however many tabs), with when they last typed, then the agents waiting on
   * it (and the copilot while a person drives).
   */
  watchers(terminalId: string): TerminalWatcher[] {
    const people = new Map<string, TerminalWatcher>()
    for (const v of this.byTerminal.get(terminalId) ?? []) {
      if (people.has(v.userId)) continue
      people.set(v.userId, {
        id: v.userId,
        kind: "human",
        name: v.name,
        avatarUrl: v.avatarUrl,
        typingAt: this.ptyManager.typingAt?.(terminalId, v.userId) ?? null,
      })
    }
    return [...people.values(), ...(this.ptyManager.agentWatchers?.(terminalId) ?? [])]
  }

  /** A session's list entry as viewers get it: with its watchers and viewer count. */
  private crewSession(terminalId: string, session: SessionInfo | null) {
    if (!session) return null
    return {
      ...session,
      viewers: this.viewerCount(terminalId),
      watchers: this.watchers(terminalId),
    }
  }

  /** Push a session-state change (agent state, typist, driver, watchers, title…) to its viewers. */
  notifyState(terminalId: string, session: SessionInfo | null): void {
    const viewers = this.byTerminal.get(terminalId)
    if (!viewers?.size || !session) return
    const typing = this.ptyManager.lastInput(terminalId)
    const msg = JSON.stringify({
      t: "state",
      id: terminalId,
      session: this.crewSession(terminalId, session),
      typing,
      watchers: this.watchers(terminalId),
    })
    for (const v of viewers) this.sendText(v, msg)
  }

  /**
   * A session entered/left flood mode (pty-manager): while flooding the backend
   * gets no output for it, so viewers are fed screen snapshots (FLOOD_FRAME_MS,
   * skipped while a viewer is behind); when it ends, one full snapshot with
   * scrollback brings everyone back to the live stream.
   */
  notifyFlood(terminalId: string, flooding: boolean): void {
    for (const v of this.byTerminal.get(terminalId) ?? []) {
      const a = v.attachments.get(terminalId)
      if (!a) continue
      if (flooding) this.startFloodFrames(v, a)
      else {
        if (a.floodTimer) clearInterval(a.floodTimer)
        a.floodTimer = null
        a.stale = false
        void this.sendSnapshot(v, a)
      }
    }
  }

  /** Output was dropped upstream (tmux pause-after): every viewer gets a fresh snapshot. */
  resync(terminalId: string): void {
    for (const v of this.byTerminal.get(terminalId) ?? []) {
      const a = v.attachments.get(terminalId)
      if (!a) continue
      this.stats.resyncs++
      void this.sendSnapshot(v, a)
    }
  }

  private startFloodFrames(viewer: Viewer, a: Attachment): void {
    if (a.floodTimer) return
    a.floodTimer = setInterval(() => {
      if (a.syncing || a.unacked > HIGH_WATER) return
      this.stats.snapshots++
      void this.sendSnapshot(viewer, a, true)
    }, FLOOD_FRAME_MS)
  }

  dropViewers(terminalId: string, mayStay: (userId: string) => boolean): void {
    for (const v of [...(this.byTerminal.get(terminalId) ?? [])]) {
      if (mayStay(v.userId)) continue
      this.sendText(v, JSON.stringify({ t: "err", id: terminalId, code: "FORBIDDEN_TERMINAL" }))
      this.detach(v, terminalId)
    }
  }

  /** The session ended: tell its viewers and drop their attachments. */
  notifyExit(terminalId: string, exitCode: number, reason?: string): void {
    const viewers = this.byTerminal.get(terminalId)
    if (!viewers) return
    for (const v of [...viewers]) {
      this.sendText(v, JSON.stringify({ t: "exit", id: terminalId, code: exitCode, reason }))
      this.detach(v, terminalId)
    }
  }

  async close(): Promise<void> {
    clearInterval(this.reaper)
    const wss = this.wss
    this.wss = null
    for (const v of this.viewers) v.ws.terminate()
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()))
  }

  // ── Connection ────────────────────────────────────────────────────────────

  private connection(ws: WebSocket, req: IncomingMessage): void {
    const ticket = (req as IncomingMessage & { terosTicket?: Ticket }).terosTicket
    if (!ticket) {
      ws.close(4401, "unauthorized")
      return
    }
    const viewer: Viewer = {
      lastSeen: Date.now(),
      ws,
      userId: ticket.userId,
      name: ticket.name,
      avatarUrl: ticket.avatarUrl ?? null,
      attachments: new Map(),
    }
    this.viewers.add(viewer)
    this.stats.viewers = this.viewers.size
    ws.on("message", (raw, isBinary) => {
      viewer.lastSeen = Date.now()
      if (isBinary) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      this.message(viewer, msg).catch((err) => {
        this.sendText(
          viewer,
          JSON.stringify({ t: "err", id: msg.id, code: "INTERNAL", msg: String(err) }),
        )
      })
    })
    ws.on("close", () => {
      for (const id of [...viewer.attachments.keys()]) this.detach(viewer, id)
      this.viewers.delete(viewer)
      this.stats.viewers = this.viewers.size
    })
    ws.on("error", () => {})
  }

  private async message(viewer: Viewer, msg: Record<string, unknown>): Promise<void> {
    const id = typeof msg.id === "string" ? msg.id : ""
    switch (msg.t) {
      case "ping":
        this.sendText(viewer, JSON.stringify({ t: "pong", c: msg.c, s: Date.now() }))
        return
      case "attach":
        await this.attach(viewer, id, clampCols(msg.cols), clampRows(msg.rows))
        return
      case "detach":
        this.detach(viewer, id)
        return
      case "in": {
        const a = viewer.attachments.get(id)
        if (!a || typeof msg.d !== "string" || !this.ptyManager.has(id)) return
        // xterm's focus reports (DEC 1004) fire on focus gain/loss: an
        // auto-focused pane "types" without anyone touching a key. They are
        // not keystrokes — never written, never wheel-moving.
        if (msg.d === "\x1b[I" || msg.d === "\x1b[O") return
        if (this.viewOnly(a)) {
          this.sendText(
            viewer,
            JSON.stringify({
              t: "err",
              id,
              code: "TERMINAL_VIEW_ONLY",
              msg: "This is someone's personal terminal: you can watch it, your keys were not sent.",
            }),
          )
          return
        }
        const driver = this.ptyManager.driver?.(id)
        if (driver?.kind === "agent") {
          const who = driver.name || "The agent"
          this.sendText(
            viewer,
            JSON.stringify({
              t: "err",
              id,
              code: "WHEEL_HELD",
              msg: `${who} is typing in this session: your keys were not sent. Switch "Agent off" to type.`,
            }),
          )
          return
        }
        // The typist drives the size.
        this.applySize(id, a.cols, a.rows)
        this.ptyManager.write(id, msg.d, { moveCursor: false })
        // The typist drives (or is in conflict with the person driving): pty-manager announces it.
        if (
          this.ptyManager.noteInput(
            id,
            { kind: "human", id: viewer.userId, name: viewer.name },
            { kind: "human", id: viewer.userId, name: viewer.name, avatarUrl: viewer.avatarUrl },
          )
        ) {
          this.notifyState(id, this.ptyManager.describe(id))
        }
        return
      }
      case "resize": {
        const a = viewer.attachments.get(id)
        if (!a) return
        a.cols = clampCols(msg.cols)
        a.rows = clampRows(msg.rows)
        const last = this.ptyManager.lastInput(id)
        // Follow this viewer if it is the one typing (or nobody is). A
        // spectator (someone else at the wheel) never resizes the pane.
        const driver = this.ptyManager.driver?.(id)
        const spectator =
          this.viewOnly(a) ||
          (!!driver && driver.kind !== "none" && !(driver.kind === "human" && driver.id === viewer.userId))
        if (!spectator && (!last || last.kind === "agent" || last.id === viewer.userId))
          this.applySize(id, a.cols, a.rows)
        return
      }
      case "ack": {
        const a = viewer.attachments.get(id)
        if (!a || typeof msg.n !== "number") return
        a.unacked = Math.max(0, a.unacked - msg.n)
        if (a.stale && a.unacked <= LOW_WATER) {
          a.stale = false
          this.stats.resyncs++
          await this.sendSnapshot(viewer, a)
        }
        return
      }
      default:
        return
    }
  }

  private async attach(
    viewer: Viewer,
    terminalId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const denial = await checkTerminalAccess(
      this.db,
      this.ptyManager,
      { userId: viewer.userId, bridge: false },
      terminalId,
      "see",
    )
    if (denial) {
      this.sendText(viewer, JSON.stringify({ t: "err", id: terminalId, code: denial }))
      return
    }
    const workspaceId = this.ptyManager.ownerOf(terminalId) ?? ""
    const principal = await terminalPrincipal(
      this.db,
      { userId: viewer.userId, bridge: false },
      workspaceId,
    )
    const before = this.ptyManager.describe(terminalId)
    const asleep = !!before?.lifecycle && before.lifecycle !== "awake"
    if (asleep && before && !mayReachSession(before, workspaceId, principal, "use")) {
      this.sendText(
        viewer,
        JSON.stringify({
          t: "err",
          id: terminalId,
          code: "TERMINAL_ASLEEP",
          msg: "This terminal is asleep: only its person can wake it",
        }),
      )
      return
    }
    // A person opening a frozen or sleeping session wakes it (pty-manager.ts lifecycle).
    let woke: string | null = null
    try {
      woke =
        (await this.ptyManager.ensureAwake?.(terminalId, { userId: viewer.userId }))?.from ?? null
    } catch (err) {
      this.sendText(
        viewer,
        JSON.stringify({
          t: "err",
          id: terminalId,
          code: "TERMINAL_WAKE_FAILED",
          msg: String(err),
        }),
      )
      return
    }
    const still = this.ptyManager.describe(terminalId)
    if (!still || !mayReachSession(still, workspaceId, principal, "see")) {
      this.sendText(viewer, JSON.stringify({ t: "err", id: terminalId, code: "FORBIDDEN_TERMINAL" }))
      return
    }
    this.detach(viewer, terminalId)
    const a: Attachment = {
      terminalId,
      unsubscribe: () => {},
      pending: [],
      pendingBytes: 0,
      timer: null,
      floodTimer: null,
      lastFlushAt: 0,
      unacked: 0,
      stale: false,
      syncing: null,
      cols,
      rows,
      principal,
    }
    a.unsubscribe = this.ptyManager.onOutput(terminalId, (data, seq) =>
      this.output(viewer, a, data, seq),
    )
    viewer.attachments.set(terminalId, a)
    let set = this.byTerminal.get(terminalId)
    if (!set) {
      set = new Set()
      this.byTerminal.set(terminalId, set)
    }
    const newWatcher = ![...set].some((v) => v.userId === viewer.userId)
    set.add(viewer)
    this.stats.attachments++
    // A person opening the session drives its size unless someone else is
    // typing in it right now — or someone else holds the wheel (viewing is
    // read-only, and that includes the pane's size).
    const last = this.ptyManager.lastInput(terminalId)
    const driver = this.ptyManager.driver?.(terminalId)
    const spectator =
      this.viewOnly(a) ||
      (!!driver && driver.kind !== "none" && !(driver.kind === "human" && driver.id === viewer.userId))
    if (
      !spectator &&
      (!last ||
        last.kind === "agent" ||
        last.id === viewer.userId ||
        Date.now() - last.at > 30_000)
    ) {
      this.applySize(terminalId, cols, rows)
    }
    const session = this.ptyManager.describe(terminalId)
    this.sendText(
      viewer,
      JSON.stringify({
        t: "attached",
        id: terminalId,
        session: this.crewSession(terminalId, session),
        viewOnly: this.viewOnly(a),
        woke,
        typing: this.ptyManager.lastInput(terminalId),
        watchers: this.watchers(terminalId),
      }),
    )
    await this.sendSnapshot(viewer, a)
    if (this.ptyManager.isFlooding(terminalId)) this.startFloodFrames(viewer, a)
    // A new face among the watchers: the workspace's lists and the other viewers.
    if (newWatcher) this.ptyManager.announce?.(terminalId, "watchers")
    else for (const other of set) if (other !== viewer) this.notifyState(terminalId, session)
  }

  private viewOnly(a: Attachment): boolean {
    const session = this.ptyManager.describe(a.terminalId)
    const workspaceId = this.ptyManager.ownerOf(a.terminalId)
    if (!session || !workspaceId) return true
    return !mayReachSession(session, workspaceId, a.principal, "use")
  }

  private detach(viewer: Viewer, terminalId: string): void {
    const a = viewer.attachments.get(terminalId)
    if (!a) return
    a.unsubscribe()
    if (a.timer) clearTimeout(a.timer)
    if (a.floodTimer) clearInterval(a.floodTimer)
    viewer.attachments.delete(terminalId)
    const set = this.byTerminal.get(terminalId)
    set?.delete(viewer)
    if (set?.size === 0) this.byTerminal.delete(terminalId)
    // The last tab of this person closed: one face less.
    if (![...(set ?? [])].some((v) => v.userId === viewer.userId))
      this.ptyManager.announce?.(terminalId, "watchers")
  }

  private applySize(terminalId: string, cols: number, rows: number): void {
    const size = this.ptyManager.size(terminalId)
    if (!size || (size.cols === cols && size.rows === rows)) return
    this.ptyManager.resize(terminalId, cols, rows)
    const msg = JSON.stringify({ t: "size", id: terminalId, cols, rows })
    for (const v of this.byTerminal.get(terminalId) ?? []) this.sendText(v, msg)
  }

  // ── Output path ───────────────────────────────────────────────────────────

  private output(viewer: Viewer, a: Attachment, data: string, seq: number): void {
    if (a.syncing) {
      a.syncing.push({ data, seq })
      return
    }
    if (a.stale) return
    a.pending.push(data)
    a.pendingBytes += data.length
    // Leading edge: a lone chunk after a quiet spell (a keystroke's echo)
    // goes out at once; only bursts wait for the batch window.
    if (a.pendingBytes >= BATCH_MAX_BYTES || (!a.timer && Date.now() - a.lastFlushAt >= BATCH_MS)) {
      this.flush(viewer, a)
    } else if (!a.timer) a.timer = setTimeout(() => this.flush(viewer, a), BATCH_MS)
  }

  private flush(viewer: Viewer, a: Attachment): void {
    if (a.timer) clearTimeout(a.timer)
    a.timer = null
    if (!a.pending.length) return
    a.lastFlushAt = Date.now()
    const payload = Buffer.from(a.pending.join(""), "utf8")
    a.pending = []
    a.pendingBytes = 0
    if (a.stale) return
    if (viewer.ws.bufferedAmount > MAX_BUFFERED || a.unacked > HIGH_WATER) {
      // Behind: stop here; the next ack under LOW_WATER brings a snapshot.
      a.stale = true
      return
    }
    a.unacked += payload.length
    this.sendBinary(viewer, KIND_OUTPUT, a.terminalId, payload)
  }

  private async sendSnapshot(viewer: Viewer, a: Attachment, screenOnly = false): Promise<void> {
    if (a.syncing) return
    a.syncing = []
    a.pending = []
    a.pendingBytes = 0
    if (a.timer) clearTimeout(a.timer)
    a.timer = null
    try {
      const snap = screenOnly
        ? await this.ptyManager.screenSnapshot(a.terminalId)
        : await this.ptyManager.snapshot(a.terminalId)
      if (!snap || viewer.attachments.get(a.terminalId) !== a) return
      const header = JSON.stringify({
        t: "size",
        id: a.terminalId,
        cols: snap.cols,
        rows: snap.rows,
      })
      this.sendText(viewer, header)
      const payload = Buffer.from(snap.data, "utf8")
      a.unacked += payload.length
      this.stats.snapshots++
      this.sendBinary(viewer, KIND_SNAPSHOT, a.terminalId, payload)
      const after = a.syncing.filter((o) => o.seq > snap.seq)
      a.syncing = null
      for (const o of after) this.output(viewer, a, o.data, o.seq)
    } finally {
      a.syncing = null
    }
  }

  private sendBinary(viewer: Viewer, kind: number, terminalId: string, payload: Buffer): void {
    if (viewer.ws.readyState !== WebSocket.OPEN) return
    const id = Buffer.from(terminalId, "utf8")
    const frame = Buffer.allocUnsafe(2 + id.length + payload.length)
    frame[0] = kind
    frame[1] = id.length
    id.copy(frame, 2)
    payload.copy(frame, 2 + id.length)
    this.stats.bytesOut += frame.length
    viewer.ws.send(frame, { binary: true })
  }

  private sendText(viewer: Viewer, text: string): void {
    if (viewer.ws.readyState === WebSocket.OPEN) viewer.ws.send(text)
  }
}

function clampCols(v: unknown): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(MAX_COLS, Math.max(MIN_COLS, n)) : 120
}

function clampRows(v: unknown): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(MAX_ROWS, Math.max(MIN_ROWS, n)) : 45
}
