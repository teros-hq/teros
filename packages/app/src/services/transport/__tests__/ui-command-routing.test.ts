import { describe, test, expect } from "bun:test"
import { WsTransport } from "../ws-transport"

const rawBroadcast = {
  type: "ui_command",
  workspaceId: "work_c327394b4cfb0661",
  userId: "user_0000000000000000",
  target: "all",
  command: {
    commandId: "cmd_repro_1",
    command: "open-window",
    target: "all",
    windowType: "board",
    props: { projectId: "proj_cd20defc41973478" },
    focus: true,
  },
}

describe("transport routing of raw ui_command", () => {
  test("raw ui_command envelope reaches 'ui_command' subscribers", () => {
    const t = new WsTransport()
    const received: unknown[] = []
    t.subscribe("ui_command", (data) => received.push(data))
    ;(t as unknown as { routeMessage: (m: unknown) => void }).routeMessage(rawBroadcast)
    expect(received.length).toBe(1)
    expect((received[0] as { type: string }).type).toBe("ui_command")
    expect((received[0] as { command: { commandId: string } }).command.commandId).toBe("cmd_repro_1")
  })
})
