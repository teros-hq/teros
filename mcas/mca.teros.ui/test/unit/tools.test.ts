/**
 * Unit tests — mca.teros.ui tool handlers against a fake bridge
 * (mca.teros.automate's test pattern; spec 20261022_ui-state-mca.md REQ-5).
 *
 * No backend, no Mongo: every tool must (1) validate its params, (2) call the
 * right backend action with the right payload (workspaceId always present),
 * (3) map the result faithfully — with `delivered: 0` surfaced as an
 * explicit, unmissable outcome.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { ToolContext } from "@teros/mca-sdk"
import { setBackendActionOverride, type BackendActionOverride } from "../../src/lib"
import {
  browserCloseTab,
  browserListTabs,
  browserOpenTab,
  browserPressKey,
  browserScroll,
  OPEN_TAB_POLL,
  uiClose,
  uiCreateDesktop,
  uiFocus,
  uiOpen,
  uiRemoveDesktop,
  uiSetDesktop,
  uiSetNavbar,
  uiSetTheme,
  uiState,
  uiUpdateProps,
} from "../../src/tools"

const USER = "user_uuuuuuuuuuuuuuuu"
const WS = "work_uiunittest00001"

type Call = { action: string; params: Record<string, unknown> }
let calls: Call[] = []
let responses: Record<string, unknown> = {}

const ctx = (over: Partial<ToolContext["execution"]> = {}): ToolContext =>
  ({
    execution: { userId: USER, appId: "app_ui", workspaceId: WS, agentId: "agent_u", channelId: "ch_u", ...over },
    backend: null,
    signal: new AbortController().signal,
  }) as unknown as ToolContext

beforeEach(() => {
  calls = []
  responses = {}
  setBackendActionOverride(
    (async (action, params) => {
      calls.push({ action, params })
      if (action in responses) return responses[action]
      throw new Error(`no fake response for ${action}`)
    }) satisfies BackendActionOverride,
  )
})

afterEach(() => setBackendActionOverride(undefined))

// ---------------------------------------------------------------------------

describe("context", () => {
  it("fails loud without workspace context", async () => {
    await expect(uiState.handler({}, ctx({ workspaceId: undefined }))).rejects.toThrow(
      "workspaceId is missing",
    )
    await expect(
      uiOpen.handler({ windowType: "chat" }, ctx({ workspaceId: "" })),
    ).rejects.toThrow("workspaceId is missing")
  })
})

describe("ui-state", () => {
  it("calls ui.get-state with the workspace and normalizes devices", async () => {
    responses["ui.get-state"] = {
      devices: [
        {
          workspaceId: WS,
          deviceId: "dev_web",
          deviceLabel: "Web · Chrome",
          desktops: [{ desktopId: "d1", layout: null }],
          activeDesktopId: "d1",
          windows: {
            w1: {
              windowId: "w1",
              type: "chat",
              props: { channelId: "ch_1", agentId: "agent_1" },
              enrichment: { agentName: "Alice", channelTitle: "Design" },
            },
          },
          focusedWindowId: "w1",
          windowTypes: [{ type: "chat", displayName: "Chat" }],
          lastSeen: "2026-10-23T06:00:00.000Z",
          online: true,
        },
        {
          workspaceId: WS,
          deviceId: "dev_iphone",
          desktops: [{ desktopId: "m1", layout: null }],
          activeDesktopId: "m1",
          windows: {},
          focusedWindowId: null,
          windowTypes: [],
          lastSeen: "2026-10-23T05:00:00.000Z",
          online: false,
        },
      ],
    }

    const out = (await uiState.handler({}, ctx())) as Record<string, any>
    expect(calls[0]).toEqual({ action: "ui.get-state", params: { workspaceId: WS } })
    expect(out.onlineCount).toBe(1)
    expect(out.offlineCount).toBe(1)
    expect(out.focusedWindowPerDevice).toEqual({ dev_web: "w1", dev_iphone: null })
    expect(out.windowTypes).toEqual([{ type: "chat", displayName: "Chat" }])
    expect(out.devices[0].windows.w1.enrichment.agentName).toBe("Alice")
    expect(out.note).toBeUndefined()
  })

  it("empty devices = explicit offline note", async () => {
    responses["ui.get-state"] = { devices: [] }
    const out = (await uiState.handler({}, ctx())) as Record<string, any>
    expect(out.onlineCount).toBe(0)
    expect(out.note).toContain("no connected client")
  })
})

describe("ui-open", () => {
  it("maps to ui.command open-window with defaults (no target = backend default)", async () => {
    responses["ui.command"] = { delivered: 2, target: "all" }
    const out = (await uiOpen.handler(
      { windowType: "chat", props: { agentId: "agent_9" } },
      ctx(),
    )) as Record<string, any>

    expect(calls[0].action).toBe("ui.command")
    expect(calls[0].params).toEqual({
      workspaceId: WS,
      command: "open-window",
      windowType: "chat",
      props: { agentId: "agent_9" },
    })
    // focus omitted → backend default (true); target omitted → backend default ('all')
    expect(calls[0].params.focus).toBeUndefined()
    expect(calls[0].params.target).toBeUndefined()

    expect(out.command).toBe("open-window")
    expect(out.delivered).toBe(2)
    expect(out.applied).toBe(true)
    expect(out.outcome).toContain("every connected device")
  })

  it("passes focus and target through when given", async () => {
    responses["ui.command"] = { delivered: 1, target: "dev_web" }
    await uiOpen.handler(
      { windowType: "board", props: { projectId: "proj_1" }, focus: false, target: "dev_web" },
      ctx(),
    )
    expect(calls[0].params).toMatchObject({
      command: "open-window",
      windowType: "board",
      props: { projectId: "proj_1" },
      focus: false,
      target: "dev_web",
    })
  })

  it("requires windowType; rejects non-object props and non-boolean focus", async () => {
    await expect(uiOpen.handler({}, ctx())).rejects.toThrow("windowType is required")
    await expect(uiOpen.handler({ windowType: "" }, ctx())).rejects.toThrow("windowType is required")
    await expect(
      uiOpen.handler({ windowType: "chat", props: ["nope"] }, ctx()),
    ).rejects.toThrow("props must be an object")
    await expect(
      uiOpen.handler({ windowType: "chat", props: "x" }, ctx()),
    ).rejects.toThrow("props must be an object")
    await expect(
      uiOpen.handler({ windowType: "chat", focus: "yes" }, ctx()),
    ).rejects.toThrow("focus must be a boolean")
    expect(calls.length).toBe(0)
  })

  it("delivered: 0 is an explicit, unmissable outcome", async () => {
    responses["ui.command"] = { delivered: 0, target: "all" }
    const out = (await uiOpen.handler({ windowType: "chat", props: {} }, ctx())) as Record<
      string,
      any
    >
    expect(out.delivered).toBe(0)
    expect(out.applied).toBe(false)
    expect(out.outcome).toContain("NOTHING HAPPENED")
    expect(out.outcome).toContain("no connected client")
    expect(out.outcome).toContain("no window was opened")
  })
})

describe("ui-close", () => {
  it("maps to ui.command close-window", async () => {
    responses["ui.command"] = { delivered: 2, target: "all" }
    const out = (await uiClose.handler({ windowId: "w_42" }, ctx())) as Record<string, any>
    expect(calls[0].params).toEqual({
      workspaceId: WS,
      command: "close-window",
      windowId: "w_42",
    })
    expect(out.applied).toBe(true)
  })

  it("requires windowId", async () => {
    await expect(uiClose.handler({}, ctx())).rejects.toThrow("windowId is required")
    expect(calls.length).toBe(0)
  })

  it("delivered: 0 phrasing mentions closing", async () => {
    responses["ui.command"] = { delivered: 0, target: "all" }
    const out = (await uiClose.handler({ windowId: "w_42" }, ctx())) as Record<string, any>
    expect(out.outcome).toContain("no connected client")
  })
})

describe("ui-update-props", () => {
  it("maps to ui.command update-window-props with the merge props", async () => {
    responses["ui.command"] = { delivered: 2, target: "all" }
    const out = (await uiUpdateProps.handler(
      { windowId: "w_term", props: { active: "term_2" } },
      ctx(),
    )) as Record<string, any>
    expect(calls[0].params).toEqual({
      workspaceId: WS,
      command: "update-window-props",
      windowId: "w_term",
      props: { active: "term_2" },
    })
    expect(out.applied).toBe(true)
  })

  it("requires windowId AND non-empty props object", async () => {
    await expect(uiUpdateProps.handler({ props: { a: 1 } }, ctx())).rejects.toThrow(
      "windowId is required",
    )
    await expect(uiUpdateProps.handler({ windowId: "w" }, ctx())).rejects.toThrow(
      "props is required",
    )
    await expect(uiUpdateProps.handler({ windowId: "w", props: {} }, ctx())).rejects.toThrow(
      "at least one key",
    )
    await expect(
      uiUpdateProps.handler({ windowId: "w", props: "x" }, ctx()),
    ).rejects.toThrow("props must be an object")
    expect(calls.length).toBe(0)
  })
})

describe("ui-focus", () => {
  it("maps to ui.command focus-window; target omitted → backend default 'active'", async () => {
    responses["ui.command"] = { delivered: 1, target: "dev_web" }
    const out = (await uiFocus.handler({ windowId: "w_1" }, ctx())) as Record<string, any>
    expect(calls[0].params).toEqual({
      workspaceId: WS,
      command: "focus-window",
      windowId: "w_1",
    })
    expect(out.target).toBe("dev_web")
    expect(out.outcome).toContain("target device")
  })

  it("requires windowId", async () => {
    await expect(uiFocus.handler({}, ctx())).rejects.toThrow("windowId is required")
  })

  it("delivered: 0 on a frontend action is explicit too", async () => {
    responses["ui.command"] = { delivered: 0, target: "active" }
    const out = (await uiFocus.handler({ windowId: "w_1" }, ctx())) as Record<string, any>
    expect(out.applied).toBe(false)
    expect(out.outcome).toContain("NOTHING HAPPENED")
  })
})

describe("ui-set-desktop", () => {
  it("maps to ui.command set-active-desktop", async () => {
    responses["ui.command"] = { delivered: 1, target: "active" }
    const out = (await uiSetDesktop.handler({ desktopId: "d2" }, ctx())) as Record<string, any>
    expect(calls[0].params).toEqual({
      workspaceId: WS,
      command: "set-active-desktop",
      desktopId: "d2",
    })
    expect(out.applied).toBe(true)
  })

  it("passes an explicit deviceId target through", async () => {
    responses["ui.command"] = { delivered: 1, target: "dev_iphone" }
    await uiSetDesktop.handler({ desktopId: "d2", target: "dev_iphone" }, ctx())
    expect(calls[0].params).toMatchObject({ target: "dev_iphone" })
  })

  it("requires desktopId", async () => {
    await expect(uiSetDesktop.handler({}, ctx())).rejects.toThrow("desktopId is required")
  })
})

describe("ui-open — targeted opens (desktopId / pane)", () => {
  it("passes desktopId and pane through to open-window", async () => {
    responses["ui.command"] = { delivered: 1, target: "dev_web" }
    await uiOpen.handler(
      {
        windowType: "todo",
        props: {},
        desktopId: "desktop_2_ab",
        pane: "right",
        target: "dev_web",
      },
      ctx(),
    )
    expect(calls[0].params).toEqual({
      workspaceId: WS,
      command: "open-window",
      windowType: "todo",
      props: {},
      desktopId: "desktop_2_ab",
      pane: "right",
      target: "dev_web",
    })
  })

  it("omits desktopId/pane when not given (backend defaults unchanged)", async () => {
    responses["ui.command"] = { delivered: 2, target: "all" }
    await uiOpen.handler({ windowType: "chat", props: {} }, ctx())
    expect(calls[0].params.desktopId).toBeUndefined()
    expect(calls[0].params.pane).toBeUndefined()
  })

  it("rejects an invalid pane value", async () => {
    await expect(
      uiOpen.handler({ windowType: "chat", pane: "diagonal" }, ctx()),
    ).rejects.toThrow("pane must be one of: left, right, top, bottom")
    expect(calls.length).toBe(0)
  })
})

describe("ui-create-desktop", () => {
  it("maps to ui.command create-desktop (name optional)", async () => {
    responses["ui.command"] = { delivered: 1, target: "active" }
    const out = (await uiCreateDesktop.handler({}, ctx())) as Record<string, any>
    expect(calls[0].params).toEqual({
      workspaceId: WS,
      command: "create-desktop",
    })
    expect(out.command).toBe("create-desktop")
    expect(out.applied).toBe(true)
  })

  it("passes a name through when given", async () => {
    responses["ui.command"] = { delivered: 1, target: "active" }
    await uiCreateDesktop.handler({ name: "Pantalla 3" }, ctx())
    expect(calls[0].params).toMatchObject({ command: "create-desktop", name: "Pantalla 3" })
  })

  it("rejects a non-string or empty name", async () => {
    await expect(uiCreateDesktop.handler({ name: 42 }, ctx())).rejects.toThrow(
      "name must be a string",
    )
    await expect(uiCreateDesktop.handler({ name: "" }, ctx())).rejects.toThrow(
      "name must not be empty",
    )
    expect(calls.length).toBe(0)
  })

  it("delivered: 0 phrasing is explicit", async () => {
    responses["ui.command"] = { delivered: 0, target: "active" }
    const out = (await uiCreateDesktop.handler({}, ctx())) as Record<string, any>
    expect(out.applied).toBe(false)
    expect(out.outcome).toContain("NOTHING HAPPENED")
  })
})

describe("ui-remove-desktop", () => {
  it("maps to ui.command remove-desktop", async () => {
    responses["ui.command"] = { delivered: 1, target: "active" }
    const out = (await uiRemoveDesktop.handler({ desktopId: "d3" }, ctx())) as Record<string, any>
    expect(calls[0].params).toEqual({
      workspaceId: WS,
      command: "remove-desktop",
      desktopId: "d3",
    })
    expect(out.applied).toBe(true)
  })

  it("requires desktopId", async () => {
    await expect(uiRemoveDesktop.handler({}, ctx())).rejects.toThrow("desktopId is required")
    expect(calls.length).toBe(0)
  })
})

describe("ui-set-navbar", () => {
  it("maps to ui.command set-navbar-collapsed with an explicit value", async () => {
    responses["ui.command"] = { delivered: 1, target: "active" }
    const out = (await uiSetNavbar.handler({ collapsed: true }, ctx())) as Record<string, any>
    expect(calls[0].params).toEqual({
      workspaceId: WS,
      command: "set-navbar-collapsed",
      collapsed: true,
    })
    expect(out.command).toBe("set-navbar-collapsed")
    expect(out.applied).toBe(true)
  })

  it("omits collapsed when not given (toggle semantics)", async () => {
    responses["ui.command"] = { delivered: 1, target: "active" }
    await uiSetNavbar.handler({}, ctx())
    expect(calls[0].params).toEqual({
      workspaceId: WS,
      command: "set-navbar-collapsed",
    })
  })

  it("rejects a non-boolean collapsed", async () => {
    await expect(uiSetNavbar.handler({ collapsed: "yes" }, ctx())).rejects.toThrow(
      "collapsed must be a boolean",
    )
    expect(calls.length).toBe(0)
  })
})

describe("ui-set-theme", () => {
  it("maps to ui.command set-theme with an explicit theme", async () => {
    responses["ui.command"] = { delivered: 1, target: "active" }
    const out = (await uiSetTheme.handler({ theme: "light" }, ctx())) as Record<string, any>
    expect(calls[0].params).toEqual({
      workspaceId: WS,
      command: "set-theme",
      theme: "light",
    })
    expect(out.command).toBe("set-theme")
    expect(out.applied).toBe(true)
  })

  it("omits theme when not given (toggle semantics)", async () => {
    responses["ui.command"] = { delivered: 1, target: "active" }
    await uiSetTheme.handler({}, ctx())
    expect(calls[0].params).toEqual({
      workspaceId: WS,
      command: "set-theme",
    })
  })

  it("rejects an invalid theme value", async () => {
    await expect(uiSetTheme.handler({ theme: "solarized" }, ctx())).rejects.toThrow(
      "theme must be 'dark' or 'light'",
    )
    expect(calls.length).toBe(0)
  })
})

describe("backend error passthrough", () => {
  it("handler errors surface with their code embedded in the message", async () => {
    for (const code of ["UI_UNKNOWN_DEVICE", "UI_RATE_LIMITED", "FORBIDDEN_WORKSPACE_ROLE"]) {
      setBackendActionOverride(async () => {
        const err = new Error(`${code} boom`)
        ;(err as { code?: string }).code = code
        throw err
      })
      await expect(uiFocus.handler({ windowId: "w" }, ctx())).rejects.toThrow(`[${code}] ${code} boom`)
    }
  })

  it("errors without a code pass through unchanged", async () => {
    setBackendActionOverride(async () => {
      throw new Error("plain failure")
    })
    await expect(uiFocus.handler({ windowId: "w" }, ctx())).rejects.toThrow("plain failure")
  })
})

// ---------------------------------------------------------------------------
// Browser tabs + more inputs (DBAC-REQ-14)
// ---------------------------------------------------------------------------

const desktopDevice = (windows: Record<string, any>, extra: Record<string, unknown> = {}) => ({
  workspaceId: WS,
  deviceId: "dev_desktop",
  deviceLabel: "Desktop · Teros",
  desktops: [{ desktopId: "d1", layout: null }],
  activeDesktopId: "d1",
  windows,
  focusedWindowId: Object.keys(windows)[0] ?? null,
  windowTypes: [{ type: "browser", displayName: "Browser" }],
  lastSeen: "2026-10-31T23:00:00.000Z",
  online: true,
  ...extra,
})

describe("browser-open-tab", () => {
  beforeEach(() => {
    OPEN_TAB_POLL.intervalMs = 5
    OPEN_TAB_POLL.timeoutMs = 60
  })

  it("[DBAC-AC-9] opens a browser window on the right of the active device and returns the new tab's id", async () => {
    let states = 0
    setBackendActionOverride(async (action, params) => {
      calls.push({ action, params })
      if (action === "ui.get-state") {
        states += 1
        // Before the open: one chat window. After: the chat + the new browser tab (reported with the real URL).
        return {
          devices: [
            desktopDevice(
              states === 1
                ? { w_chat: { windowId: "w_chat", type: "chat", props: { channelId: "c1" } } }
                : {
                    w_chat: { windowId: "w_chat", type: "chat", props: { channelId: "c1" } },
                    w_tab: { windowId: "w_tab", type: "browser", props: { url: "https://teros.ai/en", title: "Teros" }, title: "Teros" },
                  },
            ),
          ],
        }
      }
      if (action === "ui.command") return { delivered: 1, target: "dev_desktop" }
      throw new Error(`unexpected ${action}`)
    })

    const out = (await browserOpenTab.handler({ url: "teros.ai" }, ctx())) as Record<string, any>
    const open = calls.find((c) => c.action === "ui.command")!
    expect(open.params).toEqual({
      workspaceId: WS,
      command: "open-window",
      windowType: "browser",
      props: { url: "https://teros.ai" },
      pane: "right",
      focus: true,
      target: "active",
    })
    expect(out.tabId).toBe("w_tab")
    expect(out.url).toBe("https://teros.ai/en")
    expect(out.title).toBe("Teros")
    expect(out.deviceId).toBe("dev_desktop")
    expect(out.pane).toBe("right")
  })

  it("[DBAC-AC-9] returns tabId null with a note when the device never reports the window", async () => {
    setBackendActionOverride(async (action, params) => {
      calls.push({ action, params })
      if (action === "ui.get-state") return { devices: [desktopDevice({})] }
      if (action === "ui.command") return { delivered: 1, target: "dev_desktop" }
      throw new Error(`unexpected ${action}`)
    })
    const out = (await browserOpenTab.handler({ url: "https://example.com", pane: "bottom" }, ctx())) as Record<string, any>
    expect(out.tabId).toBeNull()
    expect(out.note).toContain("browser-list-tabs")
    expect(out.delivered).toBe(1)
    expect(calls.find((c) => c.action === "ui.command")!.params.pane).toBe("bottom")
  })

  it("delivered 0 → nothing opened, tabId null", async () => {
    setBackendActionOverride(async (action) => {
      if (action === "ui.get-state") return { devices: [] }
      if (action === "ui.command") return { delivered: 0, target: "active" }
      throw new Error(`unexpected ${action}`)
    })
    const out = (await browserOpenTab.handler({ url: "teros.ai" }, ctx())) as Record<string, any>
    expect(out.tabId).toBeNull()
    expect(out.delivered).toBe(0)
    expect(out.outcome).toContain("NOTHING HAPPENED")
  })

  it("validates url and pane", async () => {
    await expect(browserOpenTab.handler({}, ctx())).rejects.toThrow("url is required")
    await expect(browserOpenTab.handler({ url: "x.y", pane: "middle" }, ctx())).rejects.toThrow("pane must be")
  })
})

describe("browser-list-tabs / browser-close-tab", () => {
  it("[DBAC-AC-10] lists only browser windows with tabId/url/title/focused", async () => {
    responses["ui.get-state"] = {
      devices: [
        desktopDevice({
          w_tab: { windowId: "w_tab", type: "browser", props: { url: "https://github.com" }, title: "GitHub" },
          w_chat: { windowId: "w_chat", type: "chat", props: { channelId: "c1" } },
        }),
      ],
    }
    const out = (await browserListTabs.handler({}, ctx())) as Record<string, any>
    expect(out.totalTabs).toBe(1)
    expect(out.devices[0].tabs).toEqual([{ tabId: "w_tab", url: "https://github.com", title: "GitHub", focused: true }])
  })

  it("[DBAC-AC-10] close sends close-window for the tab on one device", async () => {
    responses["ui.command"] = { delivered: 1, target: "dev_desktop" }
    const out = (await browserCloseTab.handler({ tabId: "w_tab" }, ctx())) as Record<string, any>
    expect(calls[0]).toEqual({ action: "ui.command", params: { workspaceId: WS, command: "close-window", windowId: "w_tab", target: "active" } })
    expect(out.tabId).toBe("w_tab")
    expect(out.applied).toBe(true)
  })
})

describe("browser-scroll / browser-press-key", () => {
  it("[DBAC-AC-10] scroll validates direction and sends browser.scroll", async () => {
    await expect(browserScroll.handler({ tabId: "w_tab" }, ctx())).rejects.toThrow("direction must be")
    await expect(browserScroll.handler({ tabId: "w_tab", direction: "down", amount: 0 }, ctx())).rejects.toThrow("amount must be")
    responses["ui.command"] = { command: "browser.scroll", delivered: true, answered: true, ok: true, result: { scrolled: { direction: "down", amount: 300 }, url: "https://x.y" } }
    const out = (await browserScroll.handler({ tabId: "w_tab", direction: "down", amount: 300, observe: "summary" }, ctx())) as Record<string, any>
    expect(calls[0].params).toMatchObject({ command: "browser.scroll", tabId: "w_tab", direction: "down", amount: 300, observe: "summary" })
    expect(out.ok).toBe(true)
    expect(out.scrolled).toEqual({ direction: "down", amount: 300 })
    expect(out.url).toBe("https://x.y")
  })

  it("[DBAC-AC-10] press-key validates key/modifiers and phrases executor errors", async () => {
    await expect(browserPressKey.handler({ tabId: "w_tab" }, ctx())).rejects.toThrow("key is required")
    await expect(browserPressKey.handler({ tabId: "w_tab", key: "Enter", modifiers: ["Hyper"] }, ctx())).rejects.toThrow("modifiers must be")
    responses["ui.command"] = { command: "browser.press-key", delivered: true, answered: true, ok: false, code: "agent_control_disabled" }
    const out = (await browserPressKey.handler({ tabId: "w_tab", key: "Enter", modifiers: ["Shift"] }, ctx())) as Record<string, any>
    expect(calls[0].params).toMatchObject({ command: "browser.press-key", key: "Enter", modifiers: ["Shift"] })
    expect(out.ok).toBe(false)
    expect(out.code).toBe("agent_control_disabled")
    expect(out.outcome).toContain("consent")
  })
})
