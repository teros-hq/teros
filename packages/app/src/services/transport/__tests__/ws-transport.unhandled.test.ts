import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import { WsTransport } from "../ws-transport"
import { FakeWebSocket } from "./_fake-websocket"

const RealWebSocket = globalThis.WebSocket

let unhandled: unknown[]
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason)
}
let spies: Array<ReturnType<typeof jest.spyOn>>

beforeEach(() => {
  ;(globalThis as any).WebSocket = FakeWebSocket
  FakeWebSocket.reset()
  unhandled = []
  process.on("unhandledRejection", onUnhandled)
  spies = (["log", "warn", "error"] as const).map((m) =>
    jest.spyOn(console, m).mockImplementation(() => {}),
  )
})

afterEach(() => {
  process.off("unhandledRejection", onUnhandled)
  for (const s of spies) s.mockRestore()
  ;(globalThis as any).WebSocket = RealWebSocket
})

function connectOpen(t: WsTransport): FakeWebSocket {
  t.connect("wss://example/ws")
  const ws = FakeWebSocket.last()
  ws.simulateOpen()
  return ws
}

const settle = () => new Promise((r) => setTimeout(r, 20))

describe("failed requests nobody listens to", () => {
  it("an error reply to a fire-and-forget request raises no unhandled rejection", async () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    void t.request("terminal.agentAuthLoginCancel", { loginId: "login_1" })
    const { requestId } = ws.lastSent()
    ws.simulateMessage({
      type: "error",
      requestId,
      code: "UNKNOWN_ACTION",
      message: "Unknown action: terminal.agentAuthLoginCancel",
    })
    await settle()
    expect(unhandled).toEqual([])
  })

  it("a timed-out fire-and-forget request raises no unhandled rejection", async () => {
    const t = new WsTransport()
    connectOpen(t)
    void t.request("terminal.agentAuthLoginCancel", {}, { timeout: 1 })
    await settle()
    expect(unhandled).toEqual([])
  })

  it("a fire-and-forget request cut by a closed socket raises no unhandled rejection", async () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    void t.request("terminal.agentAuthLoginCancel", {})
    ws.simulateServerClose()
    t.disconnect()
    await settle()
    expect(unhandled).toEqual([])
  })

  it("an awaited request still rejects with the server code and message", async () => {
    const t = new WsTransport()
    const ws = connectOpen(t)
    const p = t.request("terminal.agentAuthLoginState", { loginId: "login_1" })
    const { requestId } = ws.lastSent()
    ws.simulateMessage({
      type: "error",
      requestId,
      code: "UNKNOWN_ACTION",
      message: "Unknown action: terminal.agentAuthLoginState",
    })
    const err = (await p.catch((e: unknown) => e)) as Error & { code?: string }
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe("Unknown action: terminal.agentAuthLoginState")
    expect(err.code).toBe("UNKNOWN_ACTION")
    await settle()
    expect(unhandled).toEqual([])
  })
})
