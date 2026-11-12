import { describe, expect, it } from "vitest"
import { closeNeedsConfirm } from "../../src/windows/TerminalWindow/floating/closeRule"
import type { TerminalSession } from "../../src/windows/TerminalWindow/terminalSessions"

const s = (patch: Partial<TerminalSession>) =>
  ({ command: "bash", agentState: null, driver: null, ...patch }) as TerminalSession

describe("closeNeedsConfirm", () => {
  it("closes an idle shell of mine at once", () => {
    expect(closeNeedsConfirm(s({}), "me")).toBe(false)
    expect(closeNeedsConfirm(s({ driver: { kind: "human", id: "me", since: 1 } }), "me")).toBe(
      false,
    )
    expect(closeNeedsConfirm(s({ driver: { kind: "none", since: 1 } }), "me")).toBe(false)
  })
  it("asks again when something runs, an agent is busy or someone else drives", () => {
    expect(closeNeedsConfirm(s({ command: "claude" }), "me")).toBe(true)
    expect(closeNeedsConfirm(s({ agentState: { state: "working", at: "" } }), "me")).toBe(true)
    expect(closeNeedsConfirm(s({ driver: { kind: "agent", id: "a", since: 1 } }), "me")).toBe(true)
    expect(closeNeedsConfirm(s({ driver: { kind: "human", id: "lucia", since: 1 } }), "me")).toBe(
      true,
    )
  })
})
