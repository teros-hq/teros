/**
 * StreamConnection + streamProtocol — unit tests (spec MCS-AC-5).
 *   cd packages/app && npx vitest run src/services/streams/streamClient.render.test.ts
 */
import { describe, expect, it, vi } from "vitest"
import { StreamConnection, type WebSocketLike } from "./streamClient"
import { decodeViewerFrame } from "./streamProtocol"

function fakeSocket() {
  const sent: Record<string, unknown>[] = []
  const ws: WebSocketLike & {
    sent: typeof sent
    emitText(m: unknown): void
    emitBinary(b: ArrayBuffer): void
    open(): void
  } = {
    binaryType: "blob",
    readyState: 0,
    sent,
    send: (d: string) => {
      sent.push(JSON.parse(d))
    },
    close: () => {
      ws.readyState = 3
      ws.onclose?.({})
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    emitText: (m) => ws.onmessage?.({ data: JSON.stringify(m) }),
    emitBinary: (b) => ws.onmessage?.({ data: b }),
    open: () => {
      ws.readyState = 1
      ws.onopen?.({})
    },
  }
  return ws
}

function handlers() {
  return {
    frame: vi.fn(),
    attached: vi.fn(),
    state: vi.fn(),
    closed: vi.fn(),
    error: vi.fn(),
    status: vi.fn(),
  }
}

describe("streamProtocol", () => {
  it("decodeViewerFrame reads the [kind][idLen][id][payload] layout", () => {
    const id = new TextEncoder().encode("browser-tab:w1")
    const buf = new Uint8Array([1, id.length, ...id, 9, 8]).buffer
    expect(decodeViewerFrame(buf)).toEqual({
      kind: 1,
      id: "browser-tab:w1",
      payload: new Uint8Array([9, 8]),
    })
    expect(decodeViewerFrame(new Uint8Array([1]).buffer)).toBeNull()
  })
})

describe("StreamConnection", () => {
  it("[MCS-AC-5] gets a ticket, opens the socket with it, replays attach on open and relays frames/state", async () => {
    const sockets: ReturnType<typeof fakeSocket>[] = []
    const urls: string[] = []
    const h = handlers()
    const conn = new StreamConnection(h, {
      getTicket: async () => ({ ticket: "tkt", path: "/ws/stream" }),
      wsBase: () => "ws://backend",
      makeSocket: (url) => {
        urls.push(url)
        const s = fakeSocket()
        sockets.push(s)
        return s
      },
    })
    conn.attachStream({ id: "browser-tab:w1", meta: { width: 800, height: 600, dpr: 2 } })
    conn.open()
    await Promise.resolve()
    await Promise.resolve()
    expect(urls[0]).toBe("ws://backend/ws/stream?ticket=tkt")
    expect(h.status).toHaveBeenCalledWith("connecting")
    const s = sockets[0]
    s.open()
    expect(h.status).toHaveBeenCalledWith("live")
    expect(s.sent[0]).toEqual({
      t: "attach",
      id: "browser-tab:w1",
      meta: { width: 800, height: 600, dpr: 2 },
    })

    const state = { url: "https://a", title: "A" }
    s.emitText({
      t: "attached",
      id: "browser-tab:w1",
      kind: "browser-tab",
      state,
      meta: { tabId: "w1" },
    })
    expect(h.attached).toHaveBeenCalledWith("browser-tab:w1", "browser-tab", state, { tabId: "w1" })
    s.emitText({ t: "state", id: "browser-tab:w1", state: { ...state, title: "B" } })
    expect(h.state).toHaveBeenCalledWith("browser-tab:w1", { ...state, title: "B" })
    const id = new TextEncoder().encode("browser-tab:w1")
    s.emitBinary(new Uint8Array([1, id.length, ...id, 255, 216]).buffer)
    expect(h.frame).toHaveBeenCalledWith("browser-tab:w1", 1, new Uint8Array([255, 216]))

    conn.input({ k: "navigate", url: "https://b" })
    conn.input({ k: "down", x: 1, y: 2, b: "left", cc: 1, mods: 0 })
    expect(s.sent.slice(1)).toEqual([
      { t: "in", id: "browser-tab:w1", k: "navigate", url: "https://b" },
      { t: "in", id: "browser-tab:w1", k: "down", x: 1, y: 2, b: "left", cc: 1, mods: 0 },
    ])
    s.emitText({ t: "closed", id: "browser-tab:w1", reason: "unviewed" })
    expect(h.closed).toHaveBeenCalledWith("browser-tab:w1", "unviewed")
    conn.dispose()
    expect(s.sent[s.sent.length - 1]).toEqual({ t: "detach", id: "browser-tab:w1" })
  })

  it("[MCS-AC-5] a STREAMS_UNAVAILABLE ticket → status unavailable, no reconnect; dispose stops reconnecting", async () => {
    const h = handlers()
    const conn = new StreamConnection(h, {
      getTicket: async () => {
        throw Object.assign(new Error("off"), { code: "STREAMS_UNAVAILABLE" })
      },
      wsBase: () => "ws://backend",
      makeSocket: () => {
        throw new Error("must not connect")
      },
    })
    conn.open()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.status).toHaveBeenLastCalledWith("unavailable")
    expect(h.error).toHaveBeenCalledWith("STREAMS_UNAVAILABLE", "off")
    conn.dispose()
  })
})
