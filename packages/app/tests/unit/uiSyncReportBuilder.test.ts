/**
 * Report builder unit tests (spec 20261022_ui-state-mca.md, REQ-1).
 *
 * Store state → UiStateReport mapping: desktop tree projection (split ratio,
 * containers, active tab), window props via serialize(), focused window,
 * dynamic catalog, mobile degenerate layout (Q5), and the backend caps.
 *
 *   cd packages/app && npx vitest run tests/unit/uiSyncReportBuilder.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { UI_MAX_WINDOWS } from "@teros/shared"
import { buildReport, buildWindowTypes, projectWindow } from "../../src/services/uiSync/reportBuilder"
import { type WindowTypeDefinition, windowRegistry } from "../../src/services/windowRegistry"
import type { Desktop, TilingWindow } from "../../src/store/tilingStore"

const FAKE_TYPE = "__ui_sync_test__"

// serialize DROPS `ephemeral` — raw vs serialized is observable.
const fakeDefinition: WindowTypeDefinition = {
  type: FAKE_TYPE,
  audience: "user",
  displayName: "Fake Window",
  icon: (() => null) as unknown as WindowTypeDefinition["icon"],
  color: "#000000",
  getTitle: (props) => `Fake ${props.kept ?? ""}`.trim(),
  defaultSize: { width: 100, height: 100 },
  component: (() => null) as unknown as WindowTypeDefinition["component"],
  serialize: (props) => ({ kept: props.kept }),
  deserialize: (data) => ({ kept: data.kept }),
}

beforeEach(() => {
  windowRegistry.register(fakeDefinition)
})
afterEach(() => {
  windowRegistry.unregister(FAKE_TYPE)
})

function makeWindow(id: string, props: Record<string, unknown> = {}, overrides: Partial<TilingWindow> = {}): TilingWindow {
  return {
    id,
    type: FAKE_TYPE,
    props: { kept: id, ephemeral: "drop-me", ...props },
    containerId: "c1",
    desktopIndex: 0,
    hasNotification: false,
    notificationCount: undefined,
    history: [{ type: FAKE_TYPE, props }],
    historyIndex: 0,
    ...overrides,
  } as TilingWindow
}

function makeDesktops(): Desktop[] {
  // desktop_0: split(c1[w1,w2 active w2], c2[w3]) · desktop_1: single c3[w4]
  return [
    {
      id: "desktop_0",
      name: "Main",
      layout: {
        type: "split",
        id: "s1",
        direction: "horizontal",
        ratio: 0.3,
        first: { type: "container", id: "c1", windowIds: ["w1", "w2"], activeWindowId: "w2" },
        second: { type: "container", id: "c2", windowIds: ["w3"], activeWindowId: "w3" },
      },
      activeContainerId: "c1",
    },
    {
      id: "desktop_1",
      layout: { type: "container", id: "c3", windowIds: ["w4"], activeWindowId: "w4" },
      activeContainerId: "c3",
    },
    { id: "desktop_2", name: undefined, layout: null, activeContainerId: null },
  ]
}

function makeWindows(): Record<string, TilingWindow> {
  return {
    w1: makeWindow("w1"),
    w2: makeWindow("w2", {}, { containerId: "c1" }),
    w3: makeWindow("w3", {}, { containerId: "c2" }),
    w4: makeWindow("w4", {}, { containerId: "c3", desktopIndex: 1 }),
  }
}

describe("buildReport (desktop projection)", () => {
  it("maps desktops, split ratio, containers and active tabs 1:1", () => {
    const report = buildReport({
      desktops: makeDesktops(),
      windows: makeWindows(),
      activeDesktopIndex: 0,
      workspaceId: "work_1",
      deviceId: "dev_1",
      deviceLabel: "Web · Chrome",
    })

    expect(report.workspaceId).toBe("work_1")
    expect(report.deviceId).toBe("dev_1")
    expect(report.deviceLabel).toBe("Web · Chrome")
    expect(report.userAgent).toBeUndefined()
    expect(report.activeDesktopId).toBe("desktop_0")
    expect(report.desktops).toHaveLength(3)

    const d0 = report.desktops[0]
    expect(d0.desktopId).toBe("desktop_0")
    expect(d0.name).toBe("Main")
    expect(d0.layout).toEqual({
      kind: "split",
      direction: "horizontal",
      ratio: 0.3,
      children: [
        { kind: "container", windowIds: ["w1", "w2"], activeWindowId: "w2" },
        { kind: "container", windowIds: ["w3"], activeWindowId: "w3" },
      ],
    })

    // desktop_2 is empty → layout null
    expect(report.desktops[2].layout).toBeNull()
  })

  it("focusedWindowId = active tab of the active container of the active desktop", () => {
    const report = buildReport({
      desktops: makeDesktops(),
      windows: makeWindows(),
      activeDesktopIndex: 0,
      workspaceId: "work_1",
      deviceId: "dev_1",
    })
    // c1 is the active container, its active tab is w2.
    expect(report.focusedWindowId).toBe("w2")

    const report1 = buildReport({
      desktops: makeDesktops(),
      windows: makeWindows(),
      activeDesktopIndex: 1,
      workspaceId: "work_1",
      deviceId: "dev_1",
    })
    expect(report1.activeDesktopId).toBe("desktop_1")
    expect(report1.focusedWindowId).toBe("w4")
  })

  it("serializes window props through the type's serialize() (ephemeral dropped)", () => {
    const report = buildReport({
      desktops: makeDesktops(),
      windows: makeWindows(),
      activeDesktopIndex: 0,
      workspaceId: "work_1",
      deviceId: "dev_1",
    })
    expect(Object.keys(report.windows).sort()).toEqual(["w1", "w2", "w3", "w4"])
    for (const w of Object.values(report.windows)) {
      expect(w.type).toBe(FAKE_TYPE)
      expect(w.props).toEqual({ kept: w.windowId }) // ephemeral gone
      expect(w.title).toBe(`Fake ${w.windowId}`)
      expect(w.windowId).toBeTruthy()
    }
  })

  it("falls back to raw props when serialize() throws", () => {
    const throwing: WindowTypeDefinition = {
      ...fakeDefinition,
      type: "__ui_sync_throw__",
      serialize: () => {
        throw new Error("boom")
      },
    }
    windowRegistry.register(throwing)
    try {
      const out = projectWindow(makeWindow("wx", { kept: "raw" }, { type: "__ui_sync_throw__" }))
      // Raw props kept (including ephemeral) — never a crash.
      expect(out.props).toEqual({ kept: "raw", ephemeral: "drop-me" })
    } finally {
      windowRegistry.unregister("__ui_sync_throw__")
    }
  })

  it("reports the dynamic catalog from the registry (Q4)", () => {
    const types = buildWindowTypes()
    const fake = types.find((t) => t.type === FAKE_TYPE)
    expect(fake).toBeDefined()
    expect(fake).toMatchObject({ type: FAKE_TYPE, displayName: "Fake Window", audience: "user" })
    // isLauncher omitted when falsy (optional field, sparse payload)
    expect(fake?.isLauncher).toBeUndefined()
  })

  it("caps windows at the backend limit (never rejected, extras dropped)", () => {
    const many: Record<string, TilingWindow> = {}
    const ids: string[] = []
    for (let i = 0; i < UI_MAX_WINDOWS + 10; i++) {
      const id = `w${i}`
      many[id] = makeWindow(id)
      ids.push(id)
    }
    const desktop: Desktop = {
      id: "desktop_0",
      layout: { type: "container", id: "c1", windowIds: ids, activeWindowId: ids[0] },
      activeContainerId: "c1",
    }
    const report = buildReport({
      desktops: [desktop],
      windows: many,
      activeDesktopIndex: 0,
      workspaceId: "work_1",
      deviceId: "dev_1",
    })
    expect(Object.keys(report.windows).length).toBe(UI_MAX_WINDOWS)
  })
})

describe("buildReport (mobile degenerate layout, Q5)", () => {
  it("collects every window into ONE container, no splits, no ratios", () => {
    const report = buildReport({
      desktops: makeDesktops(),
      windows: makeWindows(),
      activeDesktopIndex: 0,
      workspaceId: "work_1",
      deviceId: "dev_1",
      deviceLabel: "iPhone",
      mobile: true,
    })

    expect(report.deviceLabel).toBe("iPhone")
    const d0 = report.desktops[0]
    expect(d0.layout).toEqual({
      kind: "container",
      // depth-first order: w1, w2 (c1), then w3 (c2) — the strip order
      windowIds: ["w1", "w2", "w3"],
      activeWindowId: "w2", // the desktop's focused window
    })
    // desktop_1: single container, same degenerate form
    expect(report.desktops[1].layout).toEqual({
      kind: "container",
      windowIds: ["w4"],
      activeWindowId: "w4",
    })
    // empty desktop stays null
    expect(report.desktops[2].layout).toBeNull()
    // Same envelope otherwise: focused window + windows map unchanged
    expect(report.focusedWindowId).toBe("w2")
    expect(Object.keys(report.windows)).toHaveLength(4)
  })

  it("mobile active window falls back to the first window when no active container", () => {
    const desktop: Desktop = {
      id: "desktop_0",
      layout: { type: "container", id: "c1", windowIds: ["w1", "w2"], activeWindowId: "w2" },
      activeContainerId: null,
    }
    const report = buildReport({
      desktops: [desktop],
      windows: { w1: makeWindow("w1"), w2: makeWindow("w2") },
      activeDesktopIndex: 0,
      workspaceId: "work_1",
      deviceId: "dev_1",
      mobile: true,
    })
    expect(report.desktops[0].layout).toEqual({
      kind: "container",
      windowIds: ["w1", "w2"],
      activeWindowId: "w1", // fallback: first window of the strip
    })
  })
})

describe("buildReport (defensive edges)", () => {
  it("clamps oversized labels and names to the backend caps", () => {
    const long = "x".repeat(500)
    const report = buildReport({
      desktops: [{ id: "desktop_0", name: long, layout: null, activeContainerId: null }],
      windows: {},
      activeDesktopIndex: 0,
      workspaceId: "work_1",
      deviceId: "dev_1",
      deviceLabel: long,
    })
    expect(report.deviceLabel?.length).toBeLessThanOrEqual(200)
    expect(report.desktops[0].name?.length).toBeLessThanOrEqual(200)
  })

  it("clamps an oversized userAgent to 512 chars", () => {
    const long = "y".repeat(600)
    const report = buildReport({
      desktops: [{ id: "desktop_0", name: undefined, layout: null, activeContainerId: null }],
      windows: {},
      activeDesktopIndex: 0,
      workspaceId: "work_1",
      deviceId: "dev_1",
      userAgent: long,
    })
    expect(report.userAgent?.length).toBe(512)
  })

  it("passes a normal userAgent through unchanged", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
    const report = buildReport({
      desktops: [{ id: "desktop_0", name: undefined, layout: null, activeContainerId: null }],
      windows: {},
      activeDesktopIndex: 0,
      workspaceId: "work_1",
      deviceId: "dev_1",
      userAgent: ua,
    })
    expect(report.userAgent).toBe(ua)
  })

  it("always emits at least one desktop (backend requires ≥1)", () => {
    const report = buildReport({
      desktops: [],
      windows: {},
      activeDesktopIndex: 0,
      workspaceId: "work_1",
      deviceId: "dev_1",
    })
    expect(report.desktops).toHaveLength(1)
    expect(report.desktops[0].layout).toBeNull()
    expect(report.activeDesktopId).toBe("desktop_0")
  })

  it("only reports windows referenced by a layout (orphan windows dropped)", () => {
    const report = buildReport({
      desktops: makeDesktops(),
      windows: { ...makeWindows(), orphan: makeWindow("orphan") },
      activeDesktopIndex: 0,
      workspaceId: "work_1",
      deviceId: "dev_1",
    })
    expect(report.windows.orphan).toBeUndefined()
    expect(Object.keys(report.windows)).toHaveLength(4)
  })
})
