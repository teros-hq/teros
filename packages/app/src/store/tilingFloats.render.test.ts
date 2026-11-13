import { Platform } from "react-native"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { configurePersistedDriver, STORAGE_KEYS, storage } from "../services/storage"
import { type WindowTypeDefinition, windowRegistry } from "../services/windowRegistry"
import { FLOAT_DEFAULT, MAX_FLOATS } from "./floatGeometry"
import {
  type ContainerNode,
  isWindowOnScreen,
  type LayoutNode,
  type SerializedWorkspaceState,
  useTilingStore,
} from "./tilingStore"

const DOC = "__float_doc__"
const LIVE = "__float_live__"
const FIXED = "__float_fixed__"

function def(type: string, extra: Partial<WindowTypeDefinition> = {}): WindowTypeDefinition {
  return {
    type,
    audience: "user",
    displayName: type,
    icon: (() => null) as unknown as WindowTypeDefinition["icon"],
    color: "#000000",
    getTitle: () => type,
    defaultSize: { width: 100, height: 100 },
    component: (() => null) as unknown as WindowTypeDefinition["component"],
    serialize: (props) => props,
    deserialize: (data) => data,
    ...extra,
  }
}

function containers(node: LayoutNode | null): ContainerNode[] {
  if (!node) return []
  if (node.type === "container") return [node]
  return [...containers(node.first), ...containers(node.second)]
}

const s = () => useTilingStore.getState()
const layout = (desktop = s().activeDesktopIndex) => s().desktops[desktop].layout
const paneOf = (windowId: string, desktop?: number) =>
  containers(layout(desktop)).find((c) => c.windowIds.includes(windowId))
const tab = (n: number) => s().openWindow(LIVE, { n }, { inNewTab: true })!

beforeEach(() => {
  windowRegistry.register(def(DOC))
  windowRegistry.register(def(LIVE, { noPreview: true }))
  windowRegistry.register(def(FIXED, { noPreview: true, capabilities: { canFloat: false } }))
  configurePersistedDriver(() => "ws_float_test")
  sessionStorage.clear()
  localStorage.clear()
  useTilingStore.setState({
    windows: {},
    floats: {},
    floatSheetId: null,
    nextId: 1,
    activeDesktopIndex: 0,
  })
  s().resetDesktops()
  s().setCompactShell(false)
})
afterEach(() => {
  windowRegistry.unregister(DOC)
  windowRegistry.unregister(LIVE)
  windowRegistry.unregister(FIXED)
})

describe("floating a window of the tiling system", () => {
  it("[FLOAT-AC-1] floating keeps the same window: same id, type and props", () => {
    const a = tab(1)
    const before = s().windows[a]
    expect(s().floatWindow(a)).toBe(true)
    const after = s().windows[a]
    expect(after.id).toBe(before.id)
    expect(after.type).toBe(LIVE)
    expect(after.props).toBe(before.props)
    expect(s().floats[a]).toMatchObject({ ...FLOAT_DEFAULT, minimized: false })
  })

  it("[FLOAT-AC-1] a window type that opts out in the registry does not float", () => {
    const a = s().openWindow(FIXED, {}, { inNewTab: true })!
    expect(s().floatWindow(a)).toBe(false)
    expect(s().floats[a]).toBeUndefined()
    expect(paneOf(a)).toBeDefined()
    expect(s().openWindow(FIXED, { other: 1 }, { float: true })).toBeTruthy()
    expect(Object.keys(s().floats)).toHaveLength(0)
  })

  it("[FLOAT-AC-3] a floated tab leaves its pane and the pane shows its last tab", () => {
    const a = tab(1)
    const b = tab(2)
    const c = tab(3)
    s().setActiveTab(paneOf(a)!.id, b)
    s().floatWindow(b)
    const pane = containers(layout())[0]
    expect(pane.windowIds).toEqual([a, c])
    expect(pane.activeWindowId).toBe(c)
    expect(s().floats[b]).toBeDefined()
  })

  it("[FLOAT-AC-3] floating a tab that is not the active one leaves the active tab alone", () => {
    const a = tab(1)
    const b = tab(2)
    s().floatWindow(a)
    const pane = containers(layout())[0]
    expect(pane.windowIds).toEqual([b])
    expect(pane.activeWindowId).toBe(b)
  })

  it("[FLOAT-AC-3] floating the only tab of a pane closes that pane", () => {
    const a = tab(1)
    s().splitContainer(paneOf(a)!.id, "horizontal")
    const b = tab(2)
    expect(containers(layout())).toHaveLength(2)
    s().floatWindow(b)
    expect(containers(layout())).toHaveLength(1)
    expect(s().desktops[0].activeContainerId).toBe(paneOf(a)!.id)
    s().floatWindow(a)
    expect(layout()).toBeNull()
    expect(Object.keys(s().windows).sort()).toEqual([a, b].sort())
  })

  it("[FLOAT-AC-3] a floated preview tab stops being the desktop's preview", () => {
    const list = s().openWindow(DOC, { list: 1 }, { inNewTab: true })!
    const p = s().openWindow(DOC, { doc: 1 })!
    expect(s().windows[p].preview).toBe(true)
    s().floatWindow(p)
    expect(s().windows[p].preview).toBeFalsy()
    const next = s().openWindow(DOC, { doc: 2 })!
    expect(next).not.toBe(p)
    expect(s().windows[p].props).toEqual({ doc: 1 })
    expect(paneOf(list)!.windowIds).toContain(next)
  })

  it("[FLOAT-AC-4] docking puts it back in the pane it came from, as the active tab", () => {
    const a = tab(1)
    s().splitContainer(paneOf(a)!.id, "horizontal")
    const b = tab(2)
    const c = tab(3)
    const home = paneOf(b)!.id
    s().floatWindow(b)
    s().focusContainer(paneOf(a)!.id)
    s().dockWindow(b)
    expect(s().floats[b]).toBeUndefined()
    expect(paneOf(b)!.id).toBe(home)
    expect(paneOf(b)!.windowIds).toEqual([c, b])
    expect(paneOf(b)!.activeWindowId).toBe(b)
    expect(s().desktops[0].activeContainerId).toBe(home)
  })

  it("[FLOAT-AC-4] when its pane is gone it docks into the active pane", () => {
    const a = tab(1)
    s().splitContainer(paneOf(a)!.id, "horizontal")
    const b = tab(2)
    s().floatWindow(b)
    expect(containers(layout())).toHaveLength(1)
    s().dockWindow(b)
    expect(paneOf(b)!.id).toBe(paneOf(a)!.id)
    expect(paneOf(b)!.activeWindowId).toBe(b)
    expect(s().windows[b].containerId).toBe(paneOf(a)!.id)
  })

  it("[FLOAT-AC-4] with no pane at all, docking makes one", () => {
    const a = tab(1)
    s().floatWindow(a)
    expect(layout()).toBeNull()
    s().dockWindow(a)
    expect(containers(layout())).toHaveLength(1)
    expect(paneOf(a)!.activeWindowId).toBe(a)
    expect(s().desktops[0].activeContainerId).toBe(paneOf(a)!.id)
  })

  it("[FLOAT-AC-4] a float whose pane is on another desktop docks where the person is", () => {
    const a = tab(1)
    const keep = tab(2)
    s().floatWindow(a)
    s().addDesktop()
    const here = tab(3)
    expect(s().activeDesktopIndex).toBe(1)
    s().dockWindow(a)
    expect(paneOf(a, 1)!.id).toBe(paneOf(here, 1)!.id)
    expect(s().windows[a].desktopIndex).toBe(1)
    expect(paneOf(keep, 0)!.windowIds).toEqual([keep])
  })

  it("[FLOAT-AC-6] pressing a float brings it to the front; moving and sizing stay on screen", () => {
    const a = tab(1)
    const b = tab(2)
    tab(3)
    s().floatWindow(a)
    s().floatWindow(b)
    expect(s().floats[b].z).toBeGreaterThan(s().floats[a].z)
    s().focusWindow(a)
    expect(s().floats[a].z).toBeGreaterThan(s().floats[b].z)
    s().setFloatRect(a, { x: 40, y: 50, w: 640, h: 420 })
    expect(s().floats[a]).toMatchObject({ x: 40, y: 50, w: 640, h: 420 })
    s().setFloatRect(a, { x: 40, y: -500, w: 10, h: 10 })
    expect(s().floats[a]).toMatchObject({ y: 0, w: 300, h: 200 })
  })

  it("[FLOAT-AC-7] minimising keeps the float as a bubble; showing the window restores it in front", () => {
    const a = tab(1)
    const b = tab(2)
    tab(3)
    s().floatWindow(a)
    s().floatWindow(b)
    s().minimizeFloat(a, true)
    expect(s().floats[a].minimized).toBe(true)
    expect(s().windows[a]).toBeDefined()
    s().focusWindow(a)
    expect(s().floats[a].minimized).toBe(false)
    expect(s().floats[a].z).toBeGreaterThan(s().floats[b].z)
  })

  it("[FLOAT-AC-8] a fourth open float turns the one at the back into a bubble; nothing docks", () => {
    const ids = [1, 2, 3, 4, 5].map(tab)
    for (const id of ids.slice(0, 4)) s().floatWindow(id)
    expect(s().floats[ids[0]].minimized).toBe(true)
    expect(ids.slice(1, 4).every((id) => s().floats[id].minimized === false)).toBe(true)
    expect(containers(layout())[0].windowIds).toEqual([ids[4]])
  })

  it("[FLOAT-AC-8] past the total limit the oldest bubble goes back to its pane without taking the tab", () => {
    const ids = Array.from({ length: MAX_FLOATS + 2 }, (_, i) => tab(i + 1))
    const stay = ids[ids.length - 1]
    for (const id of ids.slice(0, MAX_FLOATS)) s().floatWindow(id)
    expect(Object.keys(s().floats)).toHaveLength(MAX_FLOATS)
    s().floatWindow(ids[MAX_FLOATS])
    expect(Object.keys(s().floats)).toHaveLength(MAX_FLOATS)
    expect(s().floats[ids[0]]).toBeUndefined()
    const pane = containers(layout())[0]
    expect(pane.windowIds).toContain(ids[0])
    expect(pane.activeWindowId).toBe(stay)
  })

  it("[FLOAT-AC-9] closing a float closes the window, like closing its tab", () => {
    const a = tab(1)
    const b = tab(2)
    s().floatWindow(a)
    s().closeWindow(a)
    expect(s().windows[a]).toBeUndefined()
    expect(s().floats[a]).toBeUndefined()
    expect(containers(layout())[0].windowIds).toEqual([b])
  })

  it("[FLOAT-AC-11] floats belong to the workspace: switching or removing a desktop leaves them floating", () => {
    const keep = tab(1)
    s().addDesktop()
    const a = tab(2)
    const other = tab(3)
    s().floatWindow(a)
    s().switchToDesktop(0)
    expect(s().floats[a]).toBeDefined()
    s().moveWindowToDesktop(a, 0)
    expect(paneOf(a, 0)).toBeUndefined()
    expect(s().removeDesktop(1)).toBe(true)
    expect(s().floats[a]).toBeDefined()
    const all = () => containers(layout(0)).flatMap((c) => c.windowIds)
    expect(all()).toContain(other)
    expect(all()).toContain(keep)
    expect(all()).not.toContain(a)
    s().dockWindow(a)
    expect(all()).toContain(a)
  })

  it("[FLOAT-AC-12] opening a window that is already floating focuses the float, on any desktop", () => {
    const a = tab(1)
    const b = tab(2)
    tab(3)
    s().floatWindow(a)
    s().floatWindow(b)
    s().minimizeFloat(a, true)
    s().addDesktop()
    const again = s().openWindow(LIVE, { n: 1 }, { inNewTab: true })
    expect(again).toBe(a)
    expect(s().activeDesktopIndex).toBe(1)
    expect(s().floats[a].minimized).toBe(false)
    expect(s().floats[a].z).toBeGreaterThan(s().floats[b].z)
    expect(layout(1)).toBeNull()
  })

  it("[FLOAT-AC-17] a window can be opened floating: no pane gets a tab and no active tab changes", () => {
    const a = tab(1)
    const b = tab(2)
    s().setActiveTab(paneOf(a)!.id, a)
    const f = s().openWindow(LIVE, { n: 9 }, { float: true })!
    expect(s().floats[f]).toMatchObject({ minimized: false })
    expect(s().windows[f]).toMatchObject({ type: LIVE, props: { n: 9 } })
    const pane = containers(layout())[0]
    expect(pane.windowIds).toEqual([a, b])
    expect(pane.activeWindowId).toBe(a)
    s().dockWindow(f)
    expect(paneOf(f)!.id).toBe(pane.id)
  })

  it("[FLOAT-AC-17] opening floating a window that sits in a pane floats that same window", () => {
    const a = tab(1)
    const b = tab(2)
    const same = s().openWindow(LIVE, { n: 1 }, { float: true })
    expect(same).toBe(a)
    expect(s().floats[a]).toBeDefined()
    expect(containers(layout())[0].windowIds).toEqual([b])
  })

  it("[FLOAT-AC-19] a window is on screen as the active tab of the focused pane or as an open float", () => {
    const a = tab(1)
    const b = tab(2)
    expect(isWindowOnScreen(s(), b)).toBe(true)
    expect(isWindowOnScreen(s(), a)).toBe(false)
    s().floatWindow(a)
    expect(isWindowOnScreen(s(), a)).toBe(true)
    s().minimizeFloat(a, true)
    expect(isWindowOnScreen(s(), a)).toBe(false)
    s().focusWindow(a)
    s().setCompactShell(true)
    expect(isWindowOnScreen(s(), a)).toBe(false)
    s().focusWindow(a)
    expect(isWindowOnScreen(s(), a)).toBe(true)

    const c = s().openWindow(LIVE, { n: 7 }, { float: true })!
    expect(isWindowOnScreen(s(), c)).toBe(true)
    expect(isWindowOnScreen(s(), a)).toBe(false)
  })
})

describe("floats are saved and restored with the layout", () => {
  it("[FLOAT-AC-2] the layout that is saved carries the floats, and a reload brings them back", async () => {
    const a = tab(1)
    const b = tab(2)
    const c = tab(3)
    s().floatWindow(a)
    s().floatWindow(b)
    s().setFloatRect(a, { x: 120, y: 140, w: 600, h: 400 })
    s().minimizeFloat(b, true)
    await s().persistToStorage()
    const saved = await storage.get<SerializedWorkspaceState>(STORAGE_KEYS.WORKSPACE_LAYOUT)
    expect(Object.keys(saved?.floats ?? {}).sort()).toEqual([a, b].sort())
    useTilingStore.setState({ windows: {}, floats: {} })
    s().resetDesktops()
    await s().restoreFromStorage()
    expect(s().floats[a]).toMatchObject({ x: 120, y: 140, w: 600, h: 400, minimized: false })
    expect(s().floats[b]).toMatchObject({ minimized: true })
    expect(s().windows[a].props).toEqual({ n: 1 })
    expect(containers(layout()).flatMap((p) => p.windowIds)).toEqual([c])
  })

  it("[FLOAT-AC-13] a saved float whose window is gone, or that sits in a pane, is not restored", async () => {
    const a = tab(1)
    const b = tab(2)
    s().floatWindow(a)
    await s().persistToStorage()
    const saved = (await storage.get<SerializedWorkspaceState>(STORAGE_KEYS.WORKSPACE_LAYOUT))!
    await storage.set(STORAGE_KEYS.WORKSPACE_LAYOUT, {
      ...saved,
      floats: { ...saved.floats, [b]: saved.floats![a], ghost: saved.floats![a] },
    })
    await s().restoreFromStorage()
    expect(Object.keys(s().floats)).toEqual([a])
  })

  it("[FLOAT-AC-13] a layout saved before floats existed restores with none", async () => {
    tab(1)
    await s().persistToStorage()
    const saved = (await storage.get<SerializedWorkspaceState>(STORAGE_KEYS.WORKSPACE_LAYOUT))!
    const { floats: _dropped, ...old } = saved
    await storage.set(STORAGE_KEYS.WORKSPACE_LAYOUT, old as SerializedWorkspaceState)
    useTilingStore.setState({ floats: { stale: { x: 0, y: 0, w: 1, h: 1, minimized: false, z: 1 } } })
    await s().restoreFromStorage()
    expect(s().floats).toEqual({})
  })

  it("[FLOAT-AC-2] an empty workspace and a reset have no floats", async () => {
    const a = tab(1)
    s().floatWindow(a)
    s().resetState()
    expect(s().floats).toEqual({})
  })
})

describe("floats on the phone shell", () => {
  it("[FLOAT-AC-10] a layout restored on the phone shell opens no sheet and leaves the saved floats as they were", async () => {
    const a = tab(1)
    const b = tab(2)
    tab(3)
    s().floatWindow(a)
    s().floatWindow(b)
    s().setFloatRect(a, { x: 700, y: 300, w: 600, h: 400 })
    s().minimizeFloat(b, true)
    await s().persistToStorage()
    useTilingStore.setState({ windows: {}, floats: {}, floatSheetId: null })
    s().resetDesktops()
    s().setCompactShell(true)
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true })
    await s().restoreFromStorage()
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true })
    expect(s().floatSheetId).toBeNull()
    expect(s().floats[a]).toMatchObject({ x: 700, y: 300, w: 600, h: 400, minimized: false })
    expect(s().floats[b]).toMatchObject({ minimized: true })
    expect(isWindowOnScreen(s(), a)).toBe(false)
  })

  it("[FLOAT-AC-10] on the phone shell one float at a time is open as a sheet, and closing it changes nothing that is saved", () => {
    const a = tab(1)
    const b = tab(2)
    tab(3)
    s().floatWindow(a)
    s().floatWindow(b)
    s().minimizeFloat(a, true)
    s().setCompactShell(true)
    const saved = JSON.stringify({ a: s().floats[a].minimized, b: s().floats[b].minimized })
    expect(s().floatSheetId).toBeNull()
    s().focusWindow(a)
    expect(s().floatSheetId).toBe(a)
    expect(isWindowOnScreen(s(), a)).toBe(true)
    expect(isWindowOnScreen(s(), b)).toBe(false)
    s().focusWindow(b)
    expect(s().floatSheetId).toBe(b)
    s().minimizeFloat(b, true)
    expect(s().floatSheetId).toBeNull()
    expect(JSON.stringify({ a: s().floats[a].minimized, b: s().floats[b].minimized })).toBe(saved)
  })

  it("[FLOAT-AC-10] a window floated on the phone shell opens as the sheet; docking or closing it closes the sheet", () => {
    const a = tab(1)
    tab(2)
    s().setCompactShell(true)
    s().floatWindow(a)
    expect(s().floatSheetId).toBe(a)
    s().dockWindow(a)
    expect(s().floatSheetId).toBeNull()
    const f = s().openWindow(LIVE, { n: 9 }, { float: true })!
    expect(s().floatSheetId).toBe(f)
    s().closeWindow(f)
    expect(s().floatSheetId).toBeNull()
  })
})

describe("floats never get lost", () => {
  it("[FLOAT-AC-13] a window that is in no pane and has no float left comes back as a tab", async () => {
    const a = tab(1)
    const b = tab(2)
    s().floatWindow(a)
    await s().persistToStorage()
    const saved = (await storage.get<SerializedWorkspaceState>(STORAGE_KEYS.WORKSPACE_LAYOUT))!
    const { floats: _dropped, ...old } = saved
    await storage.set(STORAGE_KEYS.WORKSPACE_LAYOUT, old as SerializedWorkspaceState)
    useTilingStore.setState({ windows: {}, floats: {} })
    s().resetDesktops()
    await s().restoreFromStorage()
    expect(s().floats).toEqual({})
    const pane = containers(layout())[0]
    expect(pane.windowIds).toEqual([b, a])
    expect(pane.activeWindowId).toBe(b)
    expect(s().windows[a].containerId).toBe(pane.id)
    await storage.set(STORAGE_KEYS.WORKSPACE_LAYOUT, { ...saved, floats: { [a]: null } } as never)
    await s().restoreFromStorage()
    expect(containers(layout())[0].windowIds).toEqual([b, a])
  })

  it("[FLOAT-AC-11] a float is on whichever desktop the person is on, and still docks to its own pane", () => {
    const a = tab(1)
    const keep = tab(2)
    const home = paneOf(a)!.id
    s().floatWindow(a)
    s().addDesktop()
    expect(s().windows[a].desktopIndex).toBe(1)
    expect(s().windows[keep].desktopIndex).toBe(0)
    s().switchToDesktop(0)
    expect(s().windows[a].desktopIndex).toBe(0)
    s().dockWindow(a)
    expect(paneOf(a, 0)!.id).toBe(home)
  })

  it("[FLOAT-AC-6] bringing floats to the front over and over keeps their order numbers small", () => {
    const a = tab(1)
    const b = tab(2)
    tab(3)
    s().floatWindow(a)
    s().floatWindow(b)
    for (let i = 0; i < 400; i++) s().focusWindow(i % 2 ? a : b)
    expect(Math.max(s().floats[a].z, s().floats[b].z)).toBeLessThan(300)
    expect(s().floats[a].z).toBeGreaterThan(s().floats[b].z)
  })

  it("[FLOAT-AC-1] where the floating layer does not exist (native), nothing floats: Float opens a tab, and showing a float docks it", () => {
    const a = tab(1)
    tab(2)
    s().floatWindow(a)
    const os = Platform.OS
    try {
      ;(Platform as { OS: string }).OS = "ios"
      const b = tab(3)
      expect(s().floatWindow(b)).toBe(false)
      const c = s().openWindow(LIVE, { n: 8 }, { float: true })!
      expect(s().floats[c]).toBeUndefined()
      expect(paneOf(c)).toBeDefined()
      s().focusWindow(a)
      expect(s().floats[a]).toBeUndefined()
      expect(paneOf(a)!.activeWindowId).toBe(a)
    } finally {
      ;(Platform as { OS: string }).OS = os
    }
  })
})
