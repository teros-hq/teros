/**
 * /ws/terminal data plane over a real local WebSocket: ticket auth, the
 * role rule shared with the WS domain (read members get nothing), the
 * snapshot/live-output splice, flow control (a viewer that doesn't ack stops
 * receiving output and is resynced with a snapshot) and input + presence.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { createServer, type Server } from "http"
import type { AddressInfo } from "net"
import { WebSocket } from "ws"
import { TerminalStreamServer } from "../../src/services/terminal/stream-server"

type Listener = (data: string, seq: number) => void

function makePty() {
  const listeners = new Set<Listener>()
  let seq = 0
  let size = { cols: 80, rows: 24 }
  const writes: string[] = []
  const inputs: Array<{ kind: string; id: string }> = []
  let snapshotHook: (() => void) | null = null
  const pty: any = {
    writes,
    inputs,
    /** Who holds the wheel (tests set it): null = the manager has no session. */
    wheel: null as { kind: string; id?: string; name?: string } | null,
    emit(data: string) {
      seq++
      for (const l of listeners) l(data, seq)
    },
    /** Next snapshot() call runs `fn` (output racing the capture) before answering. */
    duringSnapshot(fn: () => void) {
      snapshotHook = fn
    },
    has: (id: string) => id === "t1",
    ownerOf: (id: string) => (id === "t1" ? "work_1" : undefined),
    isHost: () => false,
    describe: (id: string) => (id === "t1" ? { terminalId: "t1", title: "one" } : null),
    driver: () => pty.wheel,
    size: () => size,
    resize: (_id: string, cols: number, rows: number) => {
      size = { cols, rows }
    },
    lastInput: () => null,
    noteInput: (_id: string, actor: { kind: string; id: string }) => {
      inputs.push(actor)
      return true
    },
    write: (_id: string, data: string) => {
      writes.push(data)
    },
    onOutput: (_id: string, l: Listener) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    flooding: false,
    isFlooding: () => pty.flooding,
    screenSnapshot: async () => ({ data: `SCREEN@${seq}`, cols: size.cols, rows: size.rows, seq }),
    snapshot: async () => {
      const at = seq
      snapshotHook?.()
      snapshotHook = null
      return { data: `SNAP@${at}`, cols: size.cols, rows: size.rows, seq: at }
    },
  }
  return pty
}

function makeDb(members: Record<string, "read" | "write">) {
  return {
    collection: (name: string) => ({
      findOne: async (filter: any) => {
        if (name === "workspaces")
          return { workspaceId: filter.workspaceId, ownerId: "owner", status: "active" }
        if (name === "workspace_members") {
          const role = members[filter.userId]
          return role ? { workspaceId: filter.workspaceId, userId: filter.userId, role } : null
        }
        return null
      },
    }),
  } as any
}

let server: Server | null = null
let stream: TerminalStreamServer | null = null
const sockets: WebSocket[] = []
// Under Bun 1.3.x `server.close()` never calls back while an upgraded socket is
// still tracked (node:http compat bug, see _remote-fakes.ts): destroy them first.
const upgraded = new Set<import("node:stream").Duplex>()

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate()
  for (const s of upgraded) s.destroy()
  upgraded.clear()
  await stream?.close()
  await new Promise<void>((r) => {
    const timer = setTimeout(r, 500)
    if (server) server.close(() => (clearTimeout(timer), r()))
    else r()
  })
  server = null
})

async function start(members: Record<string, "read" | "write"> = { owner: "write" }) {
  const pty = makePty()
  stream = new TerminalStreamServer(makeDb(members), pty as any)
  server = createServer()
  server.on("upgrade", (req, socket, head) => {
    upgraded.add(socket)
    socket.once("close", () => upgraded.delete(socket))
    stream!.handleUpgrade(req, socket, head)
  })
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()))
  const port = (server.address() as AddressInfo).port
  return { pty, url: (ticket: string) => `ws://127.0.0.1:${port}/ws/terminal?ticket=${ticket}` }
}

interface Frame {
  kind: "text" | "output" | "snapshot"
  id?: string
  data: any
}

function connect(url: string): Promise<{
  ws: WebSocket
  frames: Frame[]
  next: (pred: (f: Frame) => boolean) => Promise<Frame>
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    sockets.push(ws)
    const frames: Frame[] = []
    const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = []
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      let f: Frame
      if (isBinary) {
        const idLen = raw[1]
        f = {
          kind: raw[0] === 1 ? "output" : "snapshot",
          id: raw.subarray(2, 2 + idLen).toString(),
          data: raw.subarray(2 + idLen).toString(),
        }
      } else {
        f = { kind: "text", data: JSON.parse(raw.toString()) }
      }
      frames.push(f)
      for (const w of [...waiters]) {
        if (w.pred(f)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(f)
        }
      }
    })
    const next = (pred: (f: Frame) => boolean) =>
      new Promise<Frame>((res, rej) => {
        const found = frames.find(pred)
        if (found) return res(found)
        waiters.push({ pred, resolve: res })
        setTimeout(() => rej(new Error("timeout waiting for frame")), 3000)
      })
    ws.on("open", () => resolve({ ws, frames, next }))
    ws.on("error", reject)
    ws.on("close", () => reject(new Error("refused")))
  })
}

const send = (ws: WebSocket, msg: object) => ws.send(JSON.stringify(msg))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("/ws/terminal", () => {
  it("attaching to a sleeping session wakes it first (attached says woke), then the snapshot", async () => {
    const { url, pty } = await start()
    const order: string[] = []
    pty.ensureAwake = async (id: string, by: { userId: string }) => {
      order.push(`wake ${id} by ${by.userId}`)
      return { from: "sleeping", ms: 1200 }
    }
    const snapshot = pty.snapshot
    pty.snapshot = async () => {
      order.push("snapshot")
      return snapshot()
    }
    const { ws, next } = await connect(url(stream!.issueTicket("owner", "Owner")))
    send(ws, { t: "attach", id: "t1", cols: 100, rows: 30 })
    const attached = await next((f) => f.kind === "text" && f.data.t === "attached")
    expect(attached.data.woke).toBe("sleeping")
    await next((f) => f.kind === "snapshot")
    expect(order).toEqual(["wake t1 by owner", "snapshot"])
  })

  it("a session that cannot be woken: err TERMINAL_WAKE_FAILED, not attached", async () => {
    const { url, pty } = await start()
    pty.ensureAwake = async () => {
      throw new Error("its Bash app is gone")
    }
    const { ws, next } = await connect(url(stream!.issueTicket("owner", "Owner")))
    send(ws, { t: "attach", id: "t1", cols: 100, rows: 30 })
    const err = await next((f) => f.kind === "text" && f.data.t === "err")
    expect(err.data.code).toBe("TERMINAL_WAKE_FAILED")
    expect(stream!.viewerCount("t1")).toBe(0)
  })

  it("refuses connections without a valid ticket; tickets are single-use", async () => {
    const { url } = await start()
    await expect(connect(url("nope"))).rejects.toThrow()
    const ticket = stream!.issueTicket("owner", "Owner")
    await connect(url(ticket))
    await expect(connect(url(ticket))).rejects.toThrow()
  })

  it("read-role member: attach is refused with FORBIDDEN_WORKSPACE_ROLE and no output flows", async () => {
    const { url, pty } = await start({ reader: "read" })
    const { ws, next, frames } = await connect(url(stream!.issueTicket("reader", "Reader")))
    send(ws, { t: "attach", id: "t1", cols: 100, rows: 30 })
    const err = await next((f) => f.kind === "text" && f.data.t === "err")
    expect(err.data.code).toBe("FORBIDDEN_WORKSPACE_ROLE")
    pty.emit("secret")
    send(ws, { t: "in", id: "t1", d: "rm -rf /\r" })
    await sleep(50)
    expect(frames.some((f) => f.kind !== "text")).toBe(false)
    expect(pty.writes).toEqual([])
    expect(stream!.viewerCount("t1")).toBe(0)
  })

  it("attach: attached + size + snapshot, then batched live output; output racing the snapshot is spliced by sequence", async () => {
    const { url, pty } = await start()
    pty.emit("old") // seq 1 — before the attach, never sent as output
    const { ws, next, frames } = await connect(url(stream!.issueTicket("owner", "Owner")))
    pty.duringSnapshot(() => pty.emit("raced")) // seq 2 — after the capture point (seq 1)
    send(ws, { t: "attach", id: "t1", cols: 100, rows: 30 })
    await next((f) => f.kind === "text" && f.data.t === "attached")
    const snap = await next((f) => f.kind === "snapshot")
    expect(snap.data).toBe("SNAP@1")
    // The attaching writer drives the size.
    expect(pty.size()).toEqual({ cols: 100, rows: 30 })
    pty.emit("a")
    pty.emit("b")
    const out = await next((f) => f.kind === "output" && f.data.includes("b"))
    const outputs = frames
      .filter((f) => f.kind === "output")
      .map((f) => f.data)
      .join("")
    expect(outputs).toBe("racedab")
    expect(out.id).toBe("t1")
    expect(stream!.viewerCount("t1")).toBe(1)
  })

  it("flow control: a viewer that stops acking stops receiving output; acking resyncs it with a snapshot", async () => {
    const { url, pty } = await start()
    const { ws, next, frames } = await connect(url(stream!.issueTicket("owner", "Owner")))
    send(ws, { t: "attach", id: "t1", cols: 80, rows: 24 })
    await next((f) => f.kind === "snapshot")
    const chunk = "y\n".repeat(32 * 1024) // 64 KiB
    for (let i = 0; i < 64; i++) pty.emit(chunk) // 4 MiB, never acked
    await sleep(100)
    const sent = frames.filter((f) => f.kind === "output").reduce((n, f) => n + f.data.length, 0)
    expect(sent).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024)
    expect(sent).toBeGreaterThan(0)
    const snapshotsBefore = frames.filter((f) => f.kind === "snapshot").length
    send(ws, { t: "ack", id: "t1", n: sent + 10 })
    await next(
      (f) =>
        f.kind === "snapshot" &&
        frames.filter((x) => x.kind === "snapshot").length > snapshotsBefore,
    )
    expect(stream!.stats.resyncs).toBe(1)
    pty.emit("fresh")
    await next((f) => f.kind === "output" && f.data === "fresh")
  })

  it("input reaches the PTY (keystrokes, no waitFor cursor move) and records the human typist", async () => {
    const { url, pty } = await start()
    const { ws, next } = await connect(url(stream!.issueTicket("owner", "Owner")))
    send(ws, { t: "attach", id: "t1", cols: 80, rows: 24 })
    await next((f) => f.kind === "snapshot")
    send(ws, { t: "in", id: "t1", d: "ls\r" })
    await next((f) => f.kind === "text" && f.data.t === "state")
    expect(pty.writes).toEqual(["ls\r"])
    expect(pty.inputs).toEqual([{ kind: "human", id: "owner", name: "Owner" } as any])
    send(ws, { t: "ping", c: 42 })
    const pong = await next((f) => f.kind === "text" && f.data.t === "pong")
    expect(pong.data.c).toBe(42)
  })

  it("viewing is read-only: while an agent holds the wheel the viewer's keys are refused, not typed", async () => {
    const { url, pty } = await start()
    pty.wheel = { kind: "agent", id: "agent_atlas", name: "Atlas" }
    const { ws, next } = await connect(url(stream!.issueTicket("owner", "Owner")))
    send(ws, { t: "attach", id: "t1", cols: 80, rows: 24 })
    await next((f) => f.kind === "snapshot")
    send(ws, { t: "in", id: "t1", d: "ls\r" })
    const err = await next((f) => f.kind === "text" && f.data.t === "err")
    expect(err.data.code).toBe("WHEEL_HELD")
    expect(err.data.msg).toContain("Atlas has the wheel")
    expect(err.data.msg).toContain("Take the wheel")
    expect(pty.writes).toEqual([])
    expect(pty.inputs).toEqual([])
    // The wheel never moved: the agent keeps it.
    expect(pty.wheel).toMatchObject({ kind: "agent", id: "agent_atlas" })
  })

  it("xterm focus reports are not keystrokes: never written, never wheel-moving", async () => {
    const { url, pty } = await start()
    pty.wheel = { kind: "agent", id: "agent_atlas", name: "Atlas" }
    const { ws, next, frames } = await connect(url(stream!.issueTicket("owner", "Owner")))
    send(ws, { t: "attach", id: "t1", cols: 80, rows: 24 })
    await next((f) => f.kind === "snapshot")
    send(ws, { t: "in", id: "t1", d: "\x1b[I" })
    send(ws, { t: "in", id: "t1", d: "\x1b[O" })
    await sleep(80)
    expect(pty.writes).toEqual([])
    expect(pty.inputs).toEqual([])
    // Not even an err frame: they are not input at all.
    expect(frames.some((f) => f.kind === "text" && f.data.t === "err")).toBe(false)
  })

  it("passive attach never moves the wheel; a spectator never resizes the pane", async () => {
    const { url, pty } = await start()
    pty.wheel = { kind: "agent", id: "agent_atlas", name: "Atlas" }
    const { ws, next } = await connect(url(stream!.issueTicket("owner", "Owner")))
    send(ws, { t: "attach", id: "t1", cols: 100, rows: 30 })
    await next((f) => f.kind === "snapshot")
    // The attach itself: the pane keeps the agent's size, the wheel keeps the agent.
    expect(pty.size()).toEqual({ cols: 80, rows: 24 })
    expect(pty.inputs).toEqual([])
    expect(pty.wheel).toMatchObject({ kind: "agent", id: "agent_atlas" })
    // A resize from the spectator is ignored too.
    send(ws, { t: "resize", id: "t1", cols: 120, rows: 40 })
    await sleep(80)
    expect(pty.size()).toEqual({ cols: 80, rows: 24 })
  })

  it("the driver's own keys still reach the pane (the gate is per viewer, not global)", async () => {
    const { url, pty } = await start()
    pty.wheel = { kind: "human", id: "owner", name: "Owner" }
    const { ws, next } = await connect(url(stream!.issueTicket("owner", "Owner")))
    send(ws, { t: "attach", id: "t1", cols: 80, rows: 24 })
    await next((f) => f.kind === "snapshot")
    send(ws, { t: "in", id: "t1", d: "ls\r" })
    await next((f) => f.kind === "text" && f.data.t === "state")
    expect(pty.writes).toEqual(["ls\r"])
  })

  it("exit: viewers are told and detached", async () => {
    const { url } = await start()
    const { ws, next } = await connect(url(stream!.issueTicket("owner", "Owner")))
    send(ws, { t: "attach", id: "t1", cols: 80, rows: 24 })
    await next((f) => f.kind === "snapshot")
    stream!.notifyExit("t1", 0)
    const exit = await next((f) => f.kind === "text" && f.data.t === "exit")
    expect(exit.data.id).toBe("t1")
    expect(stream!.viewerCount("t1")).toBe(0)
  })

  it("flood mode: screen frames while flooding, a full snapshot when it ends", async () => {
    const { url, pty } = await start()
    const { ws, next, frames } = await connect(url(stream!.issueTicket("owner", "Owner")))
    send(ws, { t: "attach", id: "t1", cols: 80, rows: 24 })
    await next((f) => f.kind === "snapshot")
    pty.flooding = true
    stream!.notifyFlood("t1", true)
    await sleep(700)
    const screens = frames.filter(
      (f) => f.kind === "snapshot" && String(f.data).startsWith("SCREEN@"),
    )
    expect(screens.length).toBeGreaterThanOrEqual(2)
    pty.flooding = false
    stream!.notifyFlood("t1", false)
    await next((f) => f.kind === "snapshot" && String(f.data).startsWith("SNAP@"))
    const before = frames.length
    await sleep(400)
    expect(frames.slice(before).some((f) => String(f.data).startsWith("SCREEN@"))).toBe(false)
  })
  it("watchers are identities (one per person, avatar, when they typed) plus the agents; comings and goings are announced", async () => {
    const { url, pty } = await start()
    const announced: string[] = []
    pty.announce = (_id: string, reason: string) => announced.push(reason)
    pty.typingAt = (_id: string, userId: string) => (userId === "owner" ? 1234 : null)
    pty.agentWatchers = () => [
      { id: "agent_atlas", kind: "agent", name: "Atlas", avatarUrl: "/a.png", typingAt: null },
    ]
    const a = await connect(url(stream!.issueTicket("owner", "Owner", "/owner.png")))
    const b = await connect(url(stream!.issueTicket("owner", "Owner", "/owner.png")))
    send(a.ws, { t: "attach", id: "t1", cols: 100, rows: 30 })
    const attached = await a.next((f) => f.kind === "text" && f.data.t === "attached")
    const expected = [
      { id: "owner", kind: "human", name: "Owner", avatarUrl: "/owner.png", typingAt: 1234 },
      { id: "agent_atlas", kind: "agent", name: "Atlas", avatarUrl: "/a.png", typingAt: null },
    ]
    expect(attached.data.watchers).toEqual(expected)
    expect(attached.data.session).toMatchObject({
      terminalId: "t1",
      viewers: 1,
      watchers: expected,
    })
    // A second tab of the same person: still one face, no new announcement.
    send(b.ws, { t: "attach", id: "t1", cols: 100, rows: 30 })
    await b.next((f) => f.kind === "text" && f.data.t === "attached")
    expect(stream!.watchers("t1").filter((w) => w.kind === "human")).toHaveLength(1)
    expect(announced).toEqual(["watchers"])
    send(a.ws, { t: "detach", id: "t1" })
    await sleep(50)
    expect(announced).toEqual(["watchers"])
    send(b.ws, { t: "detach", id: "t1" })
    await sleep(50)
    expect(announced).toEqual(["watchers", "watchers"])
  })
})
