/**
 * Browser command bridge unit tests (Teros Desktop F3, task tn_Q9fbZS5wwxWiYRPl).
 *
 * Contract under test — NOTHING hangs, every path answers ui.command-result:
 *   - plain web (no preload bridge) → browser_unavailable
 *   - desktop bridge ok → result forwarded verbatim
 *   - desktop bridge ok:false (consent/fence) → code+message forwarded
 *   - bridge rejection (IPC error) → browser_executor_error
 *   - bridge timeout → browser_executor_timeout (22s < backend 25s)
 *   - non-browser / malformed (no correlationId) / no workspace → skipped,
 *     nothing sent
 *   - transport failure in sendCommandResult → caught, returns skipped
 *     (backend's 25s pending timeout is the backstop)
 *
 *   cd packages/app && npx vitest run tests/unit/uiSyncBrowserBridge.test.ts
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"

const requestMock = vi.fn(async () => ({}))

vi.mock("../../src/services/terosClientSingleton", () => ({
  getTerosClient: () => ({ transport: { request: requestMock } }),
}))

let activeWorkspaceId: string | null = "work_1"
vi.mock("../../src/store/workspaceStoreRef", () => ({
  getActiveWorkspaceId: () => activeWorkspaceId,
}))

import {
  handleBrowserCommand,
  isBrowserCommand,
  getDesktopBridge,
} from "../../src/services/uiSync/browserBridge"

/** A correlated browser command event, as the backend delivers it. */
function browserEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "ui_command",
    command: {
      commandId: "cmd_1",
      command: "browser.get-state",
      target: "dev_desktop",
      tabId: "w_tab",
      correlationId: "corr_1",
      ...overrides,
    },
  }
}

/** Install/uninstall the preload bridge (window.terosDesktop). */
function setBridge(bridge: Record<string, unknown> | null) {
  const w = globalThis as { terosDesktop?: unknown }
  if (bridge === null) delete w.terosDesktop
  else w.terosDesktop = bridge
}

/** Last ui.command-result call sent to the transport: [method, payload]. */
function lastResult(): [string, Record<string, unknown>] {
  const call = requestMock.mock.calls.at(-1)
  if (!call) throw new Error("no ui.command-result was sent")
  return call as unknown as [string, Record<string, unknown>]
}

beforeEach(() => {
  requestMock.mockReset()
  requestMock.mockResolvedValue({})
  activeWorkspaceId = "work_1"
  setBridge(null)
})

afterEach(() => {
  setBridge(null)
})

describe("isBrowserCommand", () => {
  it("true solo para command strings que empiezan por browser.", () => {
    expect(isBrowserCommand({ command: "browser.click" })).toBe(true)
    expect(isBrowserCommand({ command: "open-window" })).toBe(false)
    expect(isBrowserCommand({ command: 42 })).toBe(false)
    expect(isBrowserCommand(null)).toBe(false)
    expect(isBrowserCommand("browser.click")).toBe(false)
  })
})

describe("getDesktopBridge", () => {
  it("null en web normal; el objeto cuando el preload lo inyecta", () => {
    expect(getDesktopBridge()).toBeNull()
    setBridge({ executeBrowserCommand: async () => ({ ok: true }) })
    expect(getDesktopBridge()).toBeTruthy()
  })
})

describe("handleBrowserCommand — skip paths (nada se envía)", () => {
  it("comando NO browser → skipped, sin tocar el transporte", async () => {
    const out = await handleBrowserCommand({ type: "ui_command", command: { command: "open-window", commandId: "c1" } })
    expect(out).toBe("skipped")
    expect(requestMock).not.toHaveBeenCalled()
  })

  it("browser command SIN correlationId → skipped (malformed, nada que correlar)", async () => {
    const out = await handleBrowserCommand({
      type: "ui_command",
      command: { command: "browser.click", commandId: "c1", tabId: "w_tab" },
    })
    expect(out).toBe("skipped")
    expect(requestMock).not.toHaveBeenCalled()
  })

  it("sin workspace activo → skipped (no hay dónde responder)", async () => {
    activeWorkspaceId = null
    const out = await handleBrowserCommand(browserEvent())
    expect(out).toBe("skipped")
    expect(requestMock).not.toHaveBeenCalled()
  })
})

describe("handleBrowserCommand — web normal (sin preload)", () => {
  it("responde browser_unavailable — el agente aprende que hace falta la desktop app", async () => {
    const out = await handleBrowserCommand(browserEvent())
    expect(out).toBe("forwarded")
    const [method, payload] = lastResult()!
    expect(method).toBe("ui.command-result")
    expect(payload).toMatchObject({
      workspaceId: "work_1",
      correlationId: "corr_1",
      ok: false,
      code: "browser_unavailable",
    })
    expect(payload.message).toContain("desktop app")
  })
})

describe("handleBrowserCommand — desktop bridge", () => {
  it("ok:true → el result del executor viaja tal cual", async () => {
    setBridge({
      executeBrowserCommand: vi.fn(async () => ({
        ok: true,
        result: { url: "https://github.com", snapshot: "- button [ref=e12]" },
      })),
    })
    const out = await handleBrowserCommand(browserEvent())
    expect(out).toBe("forwarded")
    const [method, payload] = lastResult()!
    expect(method).toBe("ui.command-result")
    expect(payload).toMatchObject({
      correlationId: "corr_1",
      ok: true,
      result: { url: "https://github.com", snapshot: "- button [ref=e12]" },
    })
    expect(payload.code).toBeUndefined()
  })

  it("ok:false (consent OFF / fence) → code + message viajan tal cual", async () => {
    setBridge({
      executeBrowserCommand: vi.fn(async () => ({
        ok: false,
        code: "agent_control_disabled",
        message: "consent is off",
      })),
    })
    await handleBrowserCommand(browserEvent({ command: "browser.click", ref: "e12" }))
    const [, payload] = lastResult()!
    expect(payload).toMatchObject({
      ok: false,
      code: "agent_control_disabled",
      message: "consent is off",
    })
  })

  it("el executor recibe el envelope COMPLETO (con correlationId y tabId)", async () => {
    const exec = vi.fn(async () => ({ ok: true, result: {} }))
    setBridge({ executeBrowserCommand: exec })
    await handleBrowserCommand(browserEvent({ tabId: "w_tab2" }))
    expect(exec).toHaveBeenCalledTimes(1)
    expect((exec.mock.calls[0] as unknown[])[0]).toMatchObject({
      command: "browser.get-state",
      correlationId: "corr_1",
      tabId: "w_tab2",
    })
  })

  it("bridge que RECHAZA (IPC error) → browser_executor_error con el mensaje", async () => {
    setBridge({
      executeBrowserCommand: vi.fn(async () => {
        throw new Error("main process gone")
      }),
    })
    const out = await handleBrowserCommand(browserEvent())
    expect(out).toBe("forwarded")
    const [, payload] = lastResult()!
    expect(payload).toMatchObject({
      ok: false,
      code: "browser_executor_error",
      message: "main process gone",
    })
  })

  it("bridge que no responde → browser_executor_timeout (nunca cuelga)", async () => {
    vi.useFakeTimers()
    try {
      setBridge({
        // Never settles — the withTimeout race must win.
        executeBrowserCommand: vi.fn(() => new Promise(() => {})),
      })
      const pending = handleBrowserCommand(browserEvent())
      // Advance past the 22s renderer deadline.
      await vi.advanceTimersByTimeAsync(22_000 + 10)
      const out = await pending
      expect(out).toBe("forwarded")
      const [, payload] = lastResult()!
      expect(payload).toMatchObject({
        ok: false,
        code: "browser_executor_timeout",
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("handleBrowserCommand — transporte caído al responder", () => {
  it("request rechaza → caught, skipped, sin throw al caller (backend 25s es el backstop)", async () => {
    requestMock.mockRejectedValue(new Error("ws closed"))
    setBridge({
      executeBrowserCommand: vi.fn(async () => ({ ok: true, result: { snapshot: "x" } })),
    })
    const out = await handleBrowserCommand(browserEvent())
    expect(out).toBe("skipped")
  })
})
