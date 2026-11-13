import { describe, expect, it, vi } from "vitest"

vi.mock("../../services/terosClientSingleton", () => ({
  getTerosClient: () => null,
}))

describe("TerminalWindowContent", () => {
  it("loads as a module and exports the window content", async () => {
    const mod = await import("./TerminalWindowContent")
    expect(typeof mod.TerminalWindowContent).toBe("function")
  }, 60_000)
})
