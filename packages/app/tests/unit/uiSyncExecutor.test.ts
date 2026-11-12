/**
 * Command executor unit tests (spec 20261022_ui-state-mca.md, REQ-6).
 *
 * Each command kind → the correct tilingStore call; unknown window types /
 * windowIds / desktopIds and malformed payloads → log + no-op (NFR-5);
 * commandId dedup; device-target double-check; open-window focus semantics (Q8).
 *
 *   cd packages/app && npx vitest run tests/unit/uiSyncExecutor.test.ts
 */
import { describe, expect, it, vi, beforeEach } from "vitest"
import { applyUiCommand, CommandDedup, type ExecutorStateSlice, type UiCommandEvent } from "../../src/services/uiSync/executor"

// ── Fake store: records every call, returns canned state ─────────────────────

function makeFakeStore(state?: Partial<ExecutorStateSlice>) {
  const calls: {
    openWindow?: [string, Record<string, unknown>, boolean | undefined]
    closeWindow?: string
    updateWindowProps?: [string, Record<string, unknown>]
    focusWindow?: string
    switchToDesktop?: number
    moveWindowToNewSplit?: [string, string, string, string | undefined]
    addDesktop?: undefined
    removeDesktop?: number
    renameDesktop?: [number, string]
    setNavbarCollapsed?: boolean | undefined
    setTheme?: string | undefined
  }[] = []
  const windows: Record<string, unknown> = state?.windows ?? { w1: { id: "w1" }, w2: { id: "w2" } }
  const desktops =
    state?.desktops ??
    ([
      { id: "desktop_0", layout: null, activeContainerId: null },
      { id: "desktop_1", layout: null, activeContainerId: null },
    ] as unknown as ExecutorStateSlice["desktops"])
  const activeDesktopIndex = state?.activeDesktopIndex ?? 0

  let openResult: string | null = "w_new"
  const store = {
    openWindow: (type: string, props: Record<string, unknown>, inNewTab?: boolean) => {
      calls.push({ openWindow: [type, props, inNewTab] })
      return openResult
    },
    closeWindow: (windowId: string) => void calls.push({ closeWindow: windowId }),
    updateWindowProps: (windowId: string, props: Record<string, unknown>) =>
      void calls.push({ updateWindowProps: [windowId, props] }),
    focusWindow: (windowId: string) => void calls.push({ focusWindow: windowId }),
    switchToDesktop: (index: number) => void calls.push({ switchToDesktop: index }),
    moveWindowToNewSplit: (
      windowId: string,
      targetContainerId: string,
      direction: string,
      position?: string,
    ) => void calls.push({ moveWindowToNewSplit: [windowId, targetContainerId, direction, position] }),
    addDesktop: () => {
      calls.push({ addDesktop: undefined })
      return desktops.length // fake index of the new desktop
    },
    removeDesktop: (index: number) => {
      calls.push({ removeDesktop: index })
      return true
    },
    renameDesktop: (index: number, name: string) => void calls.push({ renameDesktop: [index, name] }),
    setNavbarCollapsed: (collapsed: boolean | undefined) =>
      void calls.push({ setNavbarCollapsed: collapsed }),
    setTheme: (theme: string | undefined) => void calls.push({ setTheme: theme }),
    getState: () => ({ windows, desktops, activeDesktopIndex }) as unknown as ExecutorStateSlice,
    _setOpenResult: (v: string | null) => (openResult = v),
    _calls: calls,
  }
  return store
}

type FakeStore = ReturnType<typeof makeFakeStore>

/**
 * Build a ui_command envelope. `kind` selects the command; `cmd` carries the
 * command payload fields (windowType/props/windowId/desktopId/focus/commandId);
 * `env` overrides the envelope (target/deviceId).
 */
function makeEvent(
  kind: UiCommandEvent["command"]["command"],
  cmd: Record<string, unknown> = {},
  env: Partial<UiCommandEvent> = {},
): UiCommandEvent {
  const commandId = typeof cmd.commandId === "string" ? cmd.commandId : `cmd_${Math.random().toString(36).slice(2, 8)}`
  const target = typeof cmd.target === "string" ? cmd.target : "all"
  const { commandId: _cid, target: _tgt, ...rest } = cmd
  return {
    type: "ui_command",
    workspaceId: "work_1",
    userId: "user_1",
    target,
    ...env,
    command: { commandId, command: kind, target, ...rest } as UiCommandEvent["command"],
  }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("applyUiCommand — each kind maps to the right store call", () => {
  it("open-window: openWindow(type, props, inNewTab=true) + focus (default)", () => {
    const store = makeFakeStore()
    const dedup = new CommandDedup()
    const res = applyUiCommand(
      makeEvent("open-window", { commandId: "c1", windowType: "chat", props: { agentId: "a1" } }),
      store,
      dedup,
      "dev_me",
    )
    expect(res).toBe("applied")
    expect(store._calls).toEqual([
      { openWindow: ["chat", { agentId: "a1" }, true] },
      { focusWindow: "w_new" },
    ])
  })

  it("open-window with focus:false opens but does not focus", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("open-window", { commandId: "c2", windowType: "chat", props: {}, focus: false }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("applied")
    expect(store._calls).toEqual([{ openWindow: ["chat", {}, true] }])
  })

  it("open-window when the store returns null (blocked/unknown) does not focus", () => {
    const store = makeFakeStore()
    store._setOpenResult(null)
    const res = applyUiCommand(
      makeEvent("open-window", { commandId: "c3", windowType: "launcher", props: {} }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("applied") // delivery ≠ application; the open was attempted
    expect(store._calls).toEqual([{ openWindow: ["launcher", {}, true] }])
  })

  it("close-window: closeWindow(windowId)", () => {
    const store = makeFakeStore()
    applyUiCommand(
      makeEvent("close-window", { commandId: "c4", windowId: "w1" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(store._calls).toEqual([{ closeWindow: "w1" }])
  })

  it("update-window-props: updateWindowProps(windowId, props) — merge semantics", () => {
    const store = makeFakeStore()
    applyUiCommand(
      makeEvent("update-window-props", { commandId: "c5", windowId: "w2", props: { active: "t2" } }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(store._calls).toEqual([{ updateWindowProps: ["w2", { active: "t2" }] }])
  })

  it("focus-window: focusWindow(windowId)", () => {
    const store = makeFakeStore()
    applyUiCommand(
      makeEvent("focus-window", { commandId: "c6", windowId: "w1" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(store._calls).toEqual([{ focusWindow: "w1" }])
  })

  it("set-active-desktop: maps desktopId → index for switchToDesktop", () => {
    const store = makeFakeStore()
    applyUiCommand(
      makeEvent("set-active-desktop", { commandId: "c7", desktopId: "desktop_1" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(store._calls).toEqual([{ switchToDesktop: 1 }])
  })
})

describe("applyUiCommand — no-ops (NFR-5)", () => {
  it("unknown windowId on close-window → no store call", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("close-window", { commandId: "d1", windowId: "nope" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
    expect(store._calls).toEqual([])
  })

  it("unknown windowId on focus-window → no store call", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("focus-window", { commandId: "d2", windowId: "nope" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
    expect(store._calls).toEqual([])
  })

  it("unknown windowId on update-window-props → no store call", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("update-window-props", { commandId: "d3", windowId: "nope", props: { a: 1 } }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
    expect(store._calls).toEqual([])
  })

  it("unknown desktopId on set-active-desktop → no store call", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("set-active-desktop", { commandId: "d4", desktopId: "desktop_9" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
    expect(store._calls).toEqual([])
  })

  it("malformed props (array) on open-window → no store call", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("open-window", { commandId: "d5", windowType: "chat", props: ["not", "an", "object"] }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
    expect(store._calls).toEqual([])
  })

  it("missing windowType on open-window → no store call", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("open-window", { commandId: "d6", props: {} }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
    expect(store._calls).toEqual([])
  })

  it("unknown command kind → no store call, no crash", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("focus-window", { commandId: "d7", command: "teleport-window", windowId: "w1" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
    expect(store._calls).toEqual([])
  })

  it("a throwing store call never propagates (caught, ignored)", () => {
    const store = makeFakeStore()
    ;(store as any).openWindow = () => {
      throw new Error("store exploded")
    }
    const res = applyUiCommand(
      makeEvent("open-window", { commandId: "d8", windowType: "chat", props: {} }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
  })
})

describe("applyUiCommand — commandId dedup", () => {
  it("the same commandId twice → second is a duplicate, store called once", () => {
    const store = makeFakeStore()
    const dedup = new CommandDedup()
    const event = makeEvent("focus-window", { commandId: "dup-1", windowId: "w1" })
    const first = applyUiCommand(event, store, dedup, "dev_me")
    const second = applyUiCommand(event, store, dedup, "dev_me")
    expect(first).toBe("applied")
    expect(second).toBe("duplicate")
    expect(store._calls).toEqual([{ focusWindow: "w1" }])
  })

  it("different commandIds both apply", () => {
    const store = makeFakeStore()
    const dedup = new CommandDedup()
    applyUiCommand(
      makeEvent("focus-window", { commandId: "u1", windowId: "w1" }),
      store,
      dedup,
      "dev_me",
    )
    applyUiCommand(
      makeEvent("focus-window", { commandId: "u2", windowId: "w2" }),
      store,
      dedup,
      "dev_me",
    )
    expect(store._calls).toEqual([{ focusWindow: "w1" }, { focusWindow: "w2" }])
  })

  it("the dedup set is bounded (oldest evicted)", () => {
    const dedup = new CommandDedup()
    for (let i = 0; i < 250; i++) dedup.add(`cmd_${i}`)
    expect(dedup.size).toBeLessThanOrEqual(200)
    // The oldest ids were evicted — they count as new again.
    expect(dedup.add("cmd_0")).toBe(true)
    // Recent ones are still known.
    expect(dedup.add("cmd_249")).toBe(false)
  })

  it("a command without commandId is ignored (malformed)", () => {
    const store = makeFakeStore()
    // Built raw — makeEvent auto-fills commandId, which would defeat the test.
    const res = applyUiCommand(
      {
        type: "ui_command",
        workspaceId: "work_1",
        userId: "user_1",
        target: "all",
        command: { command: "focus-window", target: "all", windowId: "w1" } as any,
      },
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
    expect(store._calls).toEqual([])
  })
})

describe("applyUiCommand — device targeting double-check", () => {
  it("device-scoped command for ANOTHER device → ignored", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("focus-window", { commandId: "t1", windowId: "w1", target: "dev_other" }, { target: "dev_other", deviceId: "dev_other" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
    expect(store._calls).toEqual([])
  })

  it("device-scoped command for THIS device → applied", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("focus-window", { commandId: "t2", windowId: "w1", target: "dev_me" }, { target: "dev_me", deviceId: "dev_me" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("applied")
    expect(store._calls).toEqual([{ focusWindow: "w1" }])
  })

  it("broadcast (target 'all') applies regardless of deviceId", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("open-window", { commandId: "t3", windowType: "chat", props: {} }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("applied")
    expect(store._calls.length).toBe(2) // open + focus
  })

  it("unknown own deviceId (not initialised) → device-scoped command still applies conservatively", () => {
    // If our own deviceId is unknown we cannot prove the command is NOT for us;
    // the backend already filtered by topic, so apply (fail-open mirrors the
    // tilingStore workspace guard's fail-open stance).
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("focus-window", { commandId: "t4", windowId: "w1" }, { target: "dev_me", deviceId: "dev_me" }),
      store,
      new CommandDedup(),
      null,
    )
    expect(res).toBe("applied")
    expect(store._calls).toEqual([{ focusWindow: "w1" }])
  })
})

describe("applyUiCommand — targeted opens (desktopId / pane)", () => {
  /** Desktop with a layout: active container c1 holding w1. */
  const layoutDesktops = [
    { id: "desktop_0", layout: null, activeContainerId: null },
    {
      id: "desktop_2_ab",
      layout: { type: "container", id: "c1", windowIds: ["w1"], activeWindowId: "w1" },
      activeContainerId: "c1",
    },
  ] as unknown as ExecutorStateSlice["desktops"]

  it("open-window with desktopId switches to the desktop, opens, focuses — and STAYS there", () => {
    const store = makeFakeStore({ desktops: layoutDesktops, activeDesktopIndex: 0 })
    const res = applyUiCommand(
      makeEvent("open-window", { commandId: "p1", windowType: "todo", props: {}, desktopId: "desktop_2_ab" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("applied")
    expect(store._calls).toEqual([
      { switchToDesktop: 1 },
      { openWindow: ["todo", {}, true] },
      { focusWindow: "w_new" },
    ])
  })

  it("open-window with desktopId + pane splits around the desktop's active container", () => {
    const store = makeFakeStore({ desktops: layoutDesktops, activeDesktopIndex: 0 })
    const res = applyUiCommand(
      makeEvent("open-window", {
        commandId: "p2",
        windowType: "todo",
        props: {},
        desktopId: "desktop_2_ab",
        pane: "right",
      }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("applied")
    expect(store._calls).toEqual([
      { switchToDesktop: 1 },
      { openWindow: ["todo", {}, true] },
      { moveWindowToNewSplit: ["w_new", "c1", "horizontal", "after"] },
      { focusWindow: "w_new" },
    ])
  })

  it("pane 'left' → horizontal/before; 'top' → vertical/before; 'bottom' → vertical/after", () => {
    const cases: Array<[string, string, string]> = [
      ["left", "horizontal", "before"],
      ["top", "vertical", "before"],
      ["bottom", "vertical", "after"],
    ]
    for (const [pane, direction, position] of cases) {
      const store = makeFakeStore({ desktops: layoutDesktops, activeDesktopIndex: 1 })
      const res = applyUiCommand(
        makeEvent("open-window", {
          commandId: `p-${pane}`,
          windowType: "todo",
          props: {},
          pane,
        }),
        store,
        new CommandDedup(),
        "dev_me",
      )
      expect(res).toBe("applied")
      const splitCall = store._calls.find((c) => c.moveWindowToNewSplit)
      expect(splitCall).toEqual({ moveWindowToNewSplit: ["w_new", "c1", direction, position] })
    }
  })

  it("an EMPTY target desktop absorbs the pane — no split call for the first window", () => {
    const store = makeFakeStore({ activeDesktopIndex: 0 }) // desktop_1 empty
    const res = applyUiCommand(
      makeEvent("open-window", {
        commandId: "p3",
        windowType: "home",
        props: {},
        desktopId: "desktop_1",
        pane: "left",
      }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("applied")
    expect(store._calls).toEqual([
      { switchToDesktop: 1 },
      { openWindow: ["home", {}, true] },
      { focusWindow: "w_new" },
    ])
    expect(store._calls.some((c) => c.moveWindowToNewSplit)).toBe(false)
  })

  it("pane without desktopId splits around the ACTIVE desktop's active container", () => {
    const store = makeFakeStore({ desktops: layoutDesktops, activeDesktopIndex: 1 })
    const res = applyUiCommand(
      makeEvent("open-window", { commandId: "p4", windowType: "todo", props: {}, pane: "right" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("applied")
    expect(store._calls).toEqual([
      { openWindow: ["todo", {}, true] },
      { moveWindowToNewSplit: ["w_new", "c1", "horizontal", "after"] },
      { focusWindow: "w_new" },
    ])
  })

  it("unknown desktopId on open-window → ignored, no store call", () => {
    const store = makeFakeStore({ desktops: layoutDesktops, activeDesktopIndex: 0 })
    const res = applyUiCommand(
      makeEvent("open-window", { commandId: "p5", windowType: "todo", props: {}, desktopId: "desktop_9" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
    expect(store._calls).toEqual([])
  })

  it("invalid pane value → treated as absent (plain open)", () => {
    const store = makeFakeStore({ desktops: layoutDesktops, activeDesktopIndex: 1 })
    const res = applyUiCommand(
      makeEvent("open-window", { commandId: "p6", windowType: "todo", props: {}, pane: "diagonal" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("applied")
    expect(store._calls).toEqual([
      { openWindow: ["todo", {}, true] },
      { focusWindow: "w_new" },
    ])
  })
})

describe("applyUiCommand — desktop & view commands", () => {
  it("create-desktop: addDesktop + rename when a name is given", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("create-desktop", { commandId: "cd1", name: "Pantalla 3" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("applied")
    expect(store._calls).toEqual([{ addDesktop: undefined }, { renameDesktop: [2, "Pantalla 3"] }])
  })

  it("create-desktop without a name: addDesktop only", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("create-desktop", { commandId: "cd2" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("applied")
    expect(store._calls).toEqual([{ addDesktop: undefined }])
  })

  it("create-desktop at the cap (addDesktop → null) → ignored", () => {
    const store = makeFakeStore()
    ;(store as any).addDesktop = () => null
    const res = applyUiCommand(
      makeEvent("create-desktop", { commandId: "cd3" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
  })

  it("remove-desktop: maps desktopId → index", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("remove-desktop", { commandId: "rd1", desktopId: "desktop_1" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("applied")
    expect(store._calls).toEqual([{ removeDesktop: 1 }])
  })

  it("remove-desktop unknown desktopId → ignored", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("remove-desktop", { commandId: "rd2", desktopId: "desktop_9" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
    expect(store._calls).toEqual([])
  })

  it("remove-desktop refused by the store (last desktop) → ignored", () => {
    const store = makeFakeStore()
    ;(store as any).removeDesktop = () => false
    const res = applyUiCommand(
      makeEvent("remove-desktop", { commandId: "rd3", desktopId: "desktop_0" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("ignored")
  })

  it("set-navbar-collapsed: true / false / omitted (toggle)", () => {
    const cases: Array<[boolean | undefined, boolean | undefined]> = [
      [true, true],
      [false, false],
      [undefined, undefined],
    ]
    for (const [given, forwarded] of cases) {
      const store = makeFakeStore()
      const cmd: Record<string, unknown> = { commandId: `nb-${String(given)}` }
      if (given !== undefined) cmd.collapsed = given
      const res = applyUiCommand(makeEvent("set-navbar-collapsed", cmd), store, new CommandDedup(), "dev_me")
      expect(res).toBe("applied")
      expect(store._calls).toEqual([{ setNavbarCollapsed: forwarded }])
    }
  })

  it("set-theme: 'dark' / 'light' / omitted (toggle)", () => {
    const cases: Array<[string | undefined, string | undefined]> = [
      ["dark", "dark"],
      ["light", "light"],
      [undefined, undefined],
    ]
    for (const [given, forwarded] of cases) {
      const store = makeFakeStore()
      const cmd: Record<string, unknown> = { commandId: `th-${String(given)}` }
      if (given !== undefined) cmd.theme = given
      const res = applyUiCommand(makeEvent("set-theme", cmd), store, new CommandDedup(), "dev_me")
      expect(res).toBe("applied")
      expect(store._calls).toEqual([{ setTheme: forwarded }])
    }
  })

  it("set-theme with an invalid theme value → treated as toggle, not a crash", () => {
    const store = makeFakeStore()
    const res = applyUiCommand(
      makeEvent("set-theme", { commandId: "th-x", theme: "solarized" }),
      store,
      new CommandDedup(),
      "dev_me",
    )
    expect(res).toBe("applied")
    expect(store._calls).toEqual([{ setTheme: undefined }])
  })
})
