/**
 * Pin model — identity, labels, icons, visibility and the live-window bridge.
 * @spec NAV-REQ-2, NAV-REQ-6, NAV-REQ-8, NAV-REQ-9, NAV-REQ-19, NAV-REQ-20, NAV-REQ-21
 */
import { describe, expect, it, beforeAll } from "vitest"
import { windowRegistry } from "../../services/windowRegistry"
import { findPinForWindow, hasWidget, isPinVisible, isPortable, openProps, pinIcon, pinInputFromWindow, pinLabel, portableProps, reorderPinIds, splitZones, windowKey } from "./pinModel"
import type { NavbarPinData } from "../../services/NavbarApi"

const t = ((k: string) => `T(${k})`) as any

function makePin(over: Partial<NavbarPinData> = {}): NavbarPinData {
  const window = over.window ?? { type: "fake-browser", props: { path: "/a" } }
  return {
    pinId: "pin_1", workspaceId: "ws", scope: "personal", window, key: windowKey(window.type, window.props),
    display: "row", enabled: true, order: 0, factory: false, createdBy: { kind: "user", id: "u" }, createdAt: "", updatedAt: "",
    ...over,
  }
}

beforeAll(() => {
  windowRegistry.register({
    type: "fake-browser",
    audience: "user",
    displayName: "Fake",
    icon: (() => null) as any,
    phIcon: "folder-simple",
    color: "#000",
    component: (() => null) as any,
    defaultSize: { width: 100, height: 100 },
    minSize: { width: 10, height: 10 },
    getTitle: (p: any) => `Folder ${p.path}`,
    serialize: (p: any) => ({ path: p.path }),
    deserialize: (d: any) => ({ path: d.path, hydrated: true }),
  } as any)
  windowRegistry.register({
    type: "fake-tasks",
    audience: "user",
    displayName: "Fake tasks",
    icon: (() => null) as any,
    phIcon: "list-checks",
    color: "#000",
    component: (() => null) as any,
    defaultSize: { width: 100, height: 100 },
    minSize: { width: 10, height: 10 },
    getTitle: () => "Tasks",
    serialize: (p: any) => ({ workspaceId: p.workspaceId, view: p.view, focusId: p.focusId }),
    deserialize: (d: any) => ({ workspaceId: d.workspaceId, view: d.view, focusId: d.focusId }),
    widget: (() => null) as any,
    portable: (p: any) => (p.focusId ? null : { view: p.view }),
  } as any)
  windowRegistry.register({
    type: "fake-admin",
    audience: "admin",
    displayName: "Admin",
    icon: (() => null) as any,
    color: "#000",
    component: (() => null) as any,
    defaultSize: { width: 100, height: 100 },
    minSize: { width: 10, height: 10 },
    getTitle: () => "Admin",
    serialize: (p: any) => p,
    deserialize: (d: any) => d,
  } as any)
})

describe("[NAV-AC-5] windowKey", () => {
  it("is independent of prop order and ignores undefined", () => {
    expect(windowKey("x", { a: 1, b: 2 })).toBe(windowKey("x", { b: 2, a: 1, c: undefined }))
    expect(windowKey("x", {})).toBe("x:{}")
  })
})

describe("[NAV-AC-6] label, icon, open props", () => {
  it("prefers the explicit label, then the i18n key, then the window title", () => {
    expect(pinLabel(makePin({ label: "Mine" }), t)).toBe("Mine")
    expect(pinLabel(makePin({ labelKey: "nav.todo" }), t)).toBe("T(nav.todo)")
    expect(pinLabel(makePin(), t)).toBe("Folder /a")
    expect(pinLabel(makePin({ window: { type: "unknown-type", props: {} } }), t)).toBe("unknown-type")
  })
  it("icon: explicit → definition phIcon → generic; workspace links get the squares icon", () => {
    expect(pinIcon(makePin({ icon: "star" }))).toBe("star")
    expect(pinIcon(makePin())).toBe("folder-simple")
    expect(pinIcon(makePin({ window: { type: "workspace-link", props: { workspaceId: "w" } } }))).toBe("squares-four")
    expect(pinIcon(makePin({ window: { type: "unknown-type", props: {} } }))).toBe("browser")
  })
  it("openProps runs the definition's deserialize", () => {
    expect(openProps(makePin())).toEqual({ path: "/a", hydrated: true })
  })
})

describe("[NAV-REQ-8] visibility", () => {
  it("hides unknown windows and windows the viewer may not open; workspace links are always visible", () => {
    windowRegistry.setViewer(() => ({ role: "user" }))
    expect(isPinVisible(makePin())).toBe(true)
    expect(isPinVisible(makePin({ window: { type: "unknown-type", props: {} } }))).toBe(false)
    expect(isPinVisible(makePin({ window: { type: "fake-admin", props: {} } }))).toBe(false)
    expect(isPinVisible(makePin({ window: { type: "workspace-link", props: { workspaceId: "w" } } }))).toBe(true)
    windowRegistry.setViewer(() => ({ role: "admin" }))
    expect(isPinVisible(makePin({ window: { type: "fake-admin", props: {} } }))).toBe(true)
  })
})

describe("[NAV-AC-8] live windows", () => {
  it("pinInputFromWindow serializes through the definition and finds the pin of a live window", () => {
    const input = pinInputFromWindow({ type: "fake-browser", props: { path: "/a", transient: 1 } }, t)
    expect(input.window.props).toEqual({ path: "/a" })
    expect(input.label).toBe("Folder /a")
    expect(input.icon).toBe("folder-simple")
    const pins = [makePin()]
    expect(findPinForWindow(pins, { type: "fake-browser", props: { path: "/a", transient: 1 } })?.pinId).toBe("pin_1")
    expect(findPinForWindow(pins, { type: "fake-browser", props: { path: "/b" } })).toBeUndefined()
  })
  it("splitZones keeps order within each zone", () => {
    const z = splitZones([makePin({ pinId: "a", scope: "workspace" }), makePin({ pinId: "b" }), makePin({ pinId: "c", scope: "workspace" })])
    expect(z.workspace.map((p) => p.pinId)).toEqual(["a", "c"])
    expect(z.personal.map((p) => p.pinId)).toEqual(["b"])
  })
})

describe("[NAV-AC-11] reorder by dragging a row", () => {
  const ids = ["a", "b", "c", "d"]
  it("[NAV-AC-11] drops the first row below the third", () => {
    expect(reorderPinIds(ids, "a", "d")).toEqual(["b", "c", "a", "d"])
  })
  it("[NAV-AC-11] null appends to the end", () => {
    expect(reorderPinIds(ids, "b", null)).toEqual(["a", "c", "d", "b"])
  })
  it("[NAV-AC-11] dropping a row on itself or its own slot changes nothing", () => {
    expect(reorderPinIds(ids, "b", "b")).toEqual(ids)
    expect(reorderPinIds(ids, "b", "c")).toEqual(ids)
  })
  it("[NAV-AC-11] a row from the other zone is inserted at the drop position", () => {
    expect(reorderPinIds([...ids, "x"], "x", "b")).toEqual(["a", "x", "b", "c", "d"])
  })
})

describe("[NAV-AC-12][NAV-AC-13] widgets and global pins", () => {
  it("[NAV-AC-12] a window with a widget can be shown as one; one without cannot", () => {
    expect(hasWidget(makePin({ window: { type: "fake-tasks", props: {} } }))).toBe(true)
    expect(hasWidget(makePin())).toBe(false)
  })
  it("[NAV-AC-13] a plain tasks pin is portable, a focused one is not, an unknown type never is", () => {
    expect(isPortable(makePin({ window: { type: "fake-tasks", props: { workspaceId: "ws", view: "day" } } }))).toBe(true)
    expect(isPortable(makePin({ window: { type: "fake-tasks", props: { workspaceId: "ws", focusId: "n1" } } }))).toBe(false)
    expect(isPortable(makePin())).toBe(false)
  })
  it("[NAV-AC-13] a global pin opens with its portable props: the workspace id is gone, the view stays", () => {
    const pin = makePin({ global: true, window: { type: "fake-tasks", props: { workspaceId: "ws", view: "day" } } })
    expect(portableProps(pin)).toEqual({ view: "day" })
    expect(openProps(pin)).toEqual({ view: "day" })
    expect(openProps({ ...pin, global: false })).toEqual({ workspaceId: "ws", view: "day", focusId: undefined })
  })
})
