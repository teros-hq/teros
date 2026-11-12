/**
 * MCA streams (spec MCS): wire types (AC-1), the SDK side over a fake
 * socket (AC-2) and the relay over fake MCA + viewer sockets (AC-3).
 */

import { describe, expect, it } from "bun:test"
import {
  decodeStreamFrame,
  decodeViewerFrame,
  encodeStreamFrame,
  encodeViewerFrame,
  parseBackendMessage,
  parseMcaMessage,
  type WsBackendToMcaMessage,
} from "@teros/shared"
import { McaStreams, type StreamSocket } from "../../../mca-sdk/src/streams"
import { McaStreamRelay } from "../../src/services/mca-stream-relay"

describe("wire types (MCS-REQ-2/3/4)", () => {
  it("[MCS-AC-1] control frames parse in both directions; scope is required", () => {
    expect(
      parseMcaMessage({
        type: "stream_open",
        streamId: "s1",
        kind: "browser-tab",
        scope: { userId: "u", workspaceId: "w" },
      })?.type,
    ).toBe("stream_open")
    expect(parseMcaMessage({ type: "stream_open", streamId: "s1", kind: "browser-tab" })).toBeNull()
    expect(parseMcaMessage({ type: "stream_state", streamId: "s1", state: { a: 1 } })?.type).toBe(
      "stream_state",
    )
    expect(parseMcaMessage({ type: "stream_close", streamId: "s1" })?.type).toBe("stream_close")
    expect(parseBackendMessage({ type: "stream_viewers", streamId: "s1", viewers: [] })?.type).toBe(
      "stream_viewers",
    )
    expect(
      parseBackendMessage({
        type: "stream_input",
        streamId: "s1",
        viewerId: "v",
        userId: "u",
        input: { k: "x" },
      })?.type,
    ).toBe("stream_input")
    expect(
      parseBackendMessage({ type: "stream_error", streamId: "s1", code: "STREAM_LIMIT" })?.type,
    ).toBe("stream_error")
  })

  it("[MCS-AC-1] binary frames round-trip and reject a bad version", () => {
    const f = encodeStreamFrame("tab:ß", 1, new Uint8Array([9, 8]))
    expect(f[0]).toBe(1)
    expect(decodeStreamFrame(f)).toEqual({ id: "tab:ß", kind: 1, payload: new Uint8Array([9, 8]) })
    const bad = new Uint8Array(f)
    bad[0] = 2
    expect(decodeStreamFrame(bad)).toBeNull()
    const v = encodeViewerFrame("tab", 1, new Uint8Array([1]))
    expect(decodeViewerFrame(v)).toEqual({ id: "tab", kind: 1, payload: new Uint8Array([1]) })
  })
})

// ── SDK ──────────────────────────────────────────────────────────────────────

function fakeSocket(buffered = 0) {
  const listeners = new Map<string, Array<(m: unknown) => void>>()
  const sent: Record<string, unknown>[] = []
  const frames: Uint8Array[] = []
  const socket: StreamSocket & {
    sent: typeof sent
    frames: typeof frames
    emit(ev: string, m?: unknown): void
    buffered: number
  } = {
    sent,
    frames,
    buffered,
    sendRaw: (m) => {
      sent.push(m)
      return true
    },
    sendBinary: (d) => {
      frames.push(d)
      return true
    },
    bufferedAmount: () => socket.buffered,
    on: ((ev: string, l: (m: unknown) => void) => {
      listeners.set(ev, [...(listeners.get(ev) ?? []), l])
      return socket
    }) as StreamSocket["on"],
    emit: (ev, m) => {
      for (const l of listeners.get(ev) ?? []) l(m)
    },
  }
  return socket
}

describe("McaStreams (MCS-REQ-5)", () => {
  it("[MCS-AC-2] open announces, send frames, input reaches the stream, reconnect re-announces", () => {
    const socket = fakeSocket()
    const streams = new McaStreams(socket)
    const s = streams.open({
      streamId: "browser-tab:w1",
      kind: "browser-tab",
      scope: { userId: "u", workspaceId: "w" },
      state: { url: "a" },
    })
    expect(socket.sent[0]).toMatchObject({
      type: "stream_open",
      streamId: "browser-tab:w1",
      kind: "browser-tab",
      state: { url: "a" },
    })
    expect(s.send(1, new Uint8Array([1, 2, 3]))).toBe(true)
    expect(decodeStreamFrame(socket.frames[0])).toEqual({
      id: "browser-tab:w1",
      kind: 1,
      payload: new Uint8Array([1, 2, 3]),
    })
    socket.buffered = 10 * 1024 * 1024
    expect(s.send(1, new Uint8Array([1]))).toBe(false)
    expect(s.dropped).toBe(1)
    socket.buffered = 0

    const inputs: unknown[] = []
    const viewers: unknown[] = []
    s.on("input", (viewerId, userId, input) => inputs.push([viewerId, userId, input]))
    s.on("viewers", (list) => viewers.push(list))
    socket.emit("stream_viewers", {
      type: "stream_viewers",
      streamId: "browser-tab:w1",
      viewers: [{ viewerId: "v1", userId: "u", meta: { width: 10 } }],
    })
    socket.emit("stream_input", {
      type: "stream_input",
      streamId: "browser-tab:w1",
      viewerId: "v1",
      userId: "u",
      input: { k: "down" },
    })
    socket.emit("stream_input", {
      type: "stream_input",
      streamId: "other",
      viewerId: "v1",
      userId: "u",
      input: { k: "down" },
    })
    expect(viewers).toEqual([[{ viewerId: "v1", userId: "u", meta: { width: 10 } }]])
    expect(inputs).toEqual([["v1", "u", { k: "down" }]])
    expect(s.hasViewers).toBe(true)

    s.setState({ url: "b" })
    expect(socket.sent[socket.sent.length - 1]).toEqual({
      type: "stream_state",
      streamId: "browser-tab:w1",
      state: { url: "b" },
    })
    socket.emit("connected")
    expect(socket.sent[socket.sent.length - 1]).toMatchObject({
      type: "stream_open",
      state: { url: "b" },
    })

    s.close("done")
    expect(socket.sent[socket.sent.length - 1]).toEqual({
      type: "stream_close",
      streamId: "browser-tab:w1",
      reason: "done",
    })
    expect(streams.get("browser-tab:w1")).toBeUndefined()
    expect(s.send(1, new Uint8Array([1]))).toBe(false)
  })
})

// ── Relay ────────────────────────────────────────────────────────────────────

function fakeViewerWs() {
  const sent: Array<string | Uint8Array> = []
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    sent,
    send: (d: string | Uint8Array) => {
      sent.push(d)
    },
    terminate: () => {},
    close: () => {},
    on: () => {},
  }
  return ws
}

type Viewer = Parameters<McaStreamRelay["message"]>[0]

function relayWith(declared = true) {
  const toMca: Array<{ appId: string; message: WsBackendToMcaMessage }> = []
  const relay = new McaStreamRelay({} as never, {
    sendToMca: (appId, message) => {
      toMca.push({ appId, message })
      return true
    },
    declaresStreams: async () => declared,
    canWrite: async (userId) => userId !== "nowrite",
    log: () => {},
  })
  return { relay, toMca }
}

/** Build a viewer the way `connection()` does, without a socket handshake. */
function viewerOf(
  userId: string,
  ws = fakeViewerWs(),
): Viewer & { ws: ReturnType<typeof fakeViewerWs> } {
  return {
    viewerId: `v-${userId}`,
    ws: ws as never,
    userId,
    lastSeen: Date.now(),
    attached: new Map(),
  } as never
}

describe("McaStreamRelay (MCS-REQ-3/4/6/8)", () => {
  it("[MCS-AC-3] an MCA without the layer is refused; frames reach attached viewers of the right user; input goes back stamped", async () => {
    const { relay: refused, toMca: refusedOut } = relayWith(false)
    await refused.open("app1", {
      type: "stream_open",
      streamId: "s",
      kind: "k",
      scope: { userId: "u", workspaceId: "w" },
    })
    expect(refusedOut[0].message).toMatchObject({
      type: "stream_error",
      code: "STREAMS_NOT_DECLARED",
    })

    const { relay, toMca } = relayWith(true)
    await relay.open("app1", {
      type: "stream_open",
      streamId: "s1",
      kind: "browser-tab",
      scope: { userId: "u", workspaceId: "w" },
      state: { url: "a" },
    })
    expect(relay.describe("s1")?.kind).toBe("browser-tab")

    const owner = viewerOf("u")
    const other = viewerOf("x")
    await relay.message(other, { t: "attach", id: "s1" })
    expect(JSON.parse(String(other.ws.sent[0]))).toMatchObject({
      t: "err",
      code: "FORBIDDEN_STREAM",
    })
    await relay.message(owner, { t: "attach", id: "nope" })
    expect(JSON.parse(String(owner.ws.sent[0]))).toMatchObject({
      t: "err",
      code: "STREAM_NOT_FOUND",
    })

    await relay.message(owner, { t: "attach", id: "s1", meta: { width: 800 } })
    expect(JSON.parse(String(owner.ws.sent[1]))).toEqual({
      t: "attached",
      id: "s1",
      kind: "browser-tab",
      state: { url: "a" },
      meta: {},
    })
    expect(toMca[toMca.length - 1].message).toEqual({
      type: "stream_viewers",
      streamId: "s1",
      viewers: [{ viewerId: "v-u", userId: "u", meta: { width: 800 } }],
    })

    relay.frame("app1", encodeStreamFrame("s1", 1, new Uint8Array([7, 7])))
    const bin = owner.ws.sent[2] as Uint8Array
    expect(decodeViewerFrame(bin)).toEqual({ id: "s1", kind: 1, payload: new Uint8Array([7, 7]) })
    relay.frame("app2", encodeStreamFrame("s1", 1, new Uint8Array([1])))
    expect(owner.ws.sent).toHaveLength(3)
    owner.ws.bufferedAmount = 5 * 1024 * 1024
    relay.frame("app1", encodeStreamFrame("s1", 1, new Uint8Array([1])))
    expect(owner.ws.sent).toHaveLength(3)
    expect(relay.stats.framesSkipped).toBe(1)
    owner.ws.bufferedAmount = 0

    await relay.message(owner, { t: "in", id: "s1", k: "down", x: 1, y: 2 })
    expect(toMca[toMca.length - 1].message).toEqual({
      type: "stream_input",
      streamId: "s1",
      viewerId: "v-u",
      userId: "u",
      input: { k: "down", x: 1, y: 2 },
    })
    await relay.message(other, { t: "in", id: "s1", k: "down" })
    expect(toMca[toMca.length - 1].message.type).toBe("stream_input")
    expect(toMca.filter((m) => m.message.type === "stream_input")).toHaveLength(1)

    relay.state("app1", { type: "stream_state", streamId: "s1", state: { url: "b" } })
    expect(JSON.parse(String(owner.ws.sent[3]))).toEqual({
      t: "state",
      id: "s1",
      state: { url: "b" },
    })

    await relay.message(owner, { t: "detach", id: "s1" })
    expect(toMca[toMca.length - 1].message).toEqual({
      type: "stream_viewers",
      streamId: "s1",
      viewers: [],
    })

    await relay.message(owner, { t: "attach", id: "s1" })
    relay.closeApp("app1")
    expect(JSON.parse(String(owner.ws.sent[owner.ws.sent.length - 1]))).toEqual({
      t: "closed",
      id: "s1",
      reason: "mca_disconnected",
    })
    expect(relay.describe("s1")).toBeNull()
    await relay.shutdown()
  })
})
