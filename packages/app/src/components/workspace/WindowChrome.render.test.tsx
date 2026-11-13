import { act, fireEvent, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { TamaguiProvider } from "tamagui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key,
    }),
  }
})
vi.mock("expo-linear-gradient", () => ({ LinearGradient: () => null }))
vi.mock("../NewConversationModal", () => ({ NewConversationModal: () => null }))
vi.mock("./FrameMelt", () => ({ FrameMelt: () => null }))
vi.mock("./MobileTilingLayout", () => ({ MobileTilingLayout: () => null }))
vi.mock("./useAwakeTabs", () => ({ useAwakeTabs: () => () => true }))

import { __resetResizeGuardForTest } from "../../lib/resizeGuard"
import { type WindowTypeDefinition, windowRegistry } from "../../services/windowRegistry"
import { useTilingStore } from "../../store/tilingStore"
import {
  useWindowChrome,
  useWindowChromeStore,
  type WindowChrome,
} from "../../store/windowChromeStore"
import { setWindowStatus, useWindowTabMetaStore } from "../../store/windowTabMetaStore"
import { FloatingWindowLayer } from "./floating/FloatingWindowLayer"
import { TAB_MARKS_YIELD, TAB_SNAP_LEAD, TAB_TITLE_KEEP, tabStripEndPad } from "./tabStrip"
import { TilingLayout } from "./TilingLayout"

const TYPE = "__chrome_probe__"
const published: Record<number, WindowChrome | null> = {}

function Probe({ windowId, n }: { windowId: string; n: number }) {
  useWindowChrome(windowId, published[n] ?? null)
  return <div data-testid={`content-${windowId}`} />
}

const definition: WindowTypeDefinition = {
  type: TYPE,
  audience: "user",
  displayName: TYPE,
  icon: (() => <span data-testid="type-icon" />) as unknown as WindowTypeDefinition["icon"],
  color: "#000000",
  noPreview: true,
  getTitle: (props) => `Tab ${props.n}`,
  defaultSize: { width: 100, height: 100 },
  component: Probe as unknown as WindowTypeDefinition["component"],
  serialize: (props) => props,
  deserialize: (data) => data,
}

const s = () => useTilingStore.getState()
const tab = (n: number, chrome: WindowChrome | null = null) => {
  published[n] = chrome
  return s().openWindow(TYPE, { n }, { inNewTab: true })!
}

function mount() {
  return render(<TilingLayout />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <TamaguiProvider config={config} defaultTheme="dark">
        {children}
      </TamaguiProvider>
    ),
  })
}

const tabOf = (c: HTMLElement, id: string) =>
  c.querySelector(`[data-tab][data-window-id="${id}"]`) as HTMLElement
const inTab = (c: HTMLElement, id: string, testId: string) =>
  tabOf(c, id).querySelector(`[data-testid="${testId}"]`)
const menuOf = (id: string) =>
  document.body.querySelector(`[data-testid="tab-context-menu-${id}"]`) as HTMLElement | null

beforeEach(() => {
  __resetResizeGuardForTest()
  Object.defineProperty(document.documentElement, "clientWidth", { value: 1280, configurable: true })
  Object.defineProperty(document.documentElement, "clientHeight", { value: 800, configurable: true })
  window.dispatchEvent(new Event("resize"))
  windowRegistry.register(definition)
  for (const key of Object.keys(published)) delete published[Number(key)]
  useTilingStore.setState({
    windows: {},
    floats: {},
    floatSheetId: null,
    nextId: 1,
    activeDesktopIndex: 0,
  })
  useWindowTabMetaStore.setState({ meta: {}, status: {} })
  useWindowChromeStore.setState({ chrome: {} })
  s().resetDesktops()
  s().setCompactShell(false)
})
afterEach(() => {
  windowRegistry.unregister(TYPE)
})

describe("a window publishes its chrome and the window system draws it", () => {
  it("[FLOAT-AC-22] a window that publishes nothing keeps its type icon, no marks, no ring and the browser's own right-click", () => {
    const a = tab(1)
    const { container, queryByTestId } = mount()
    expect(inTab(container, a, "type-icon")).toBeTruthy()
    expect(inTab(container, a, "window-marks")).toBeNull()
    expect(queryByTestId("window-ring")).toBeNull()
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
    tabOf(container, a).dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(menuOf(a)).toBeNull()
  })

  it("[FLOAT-AC-22] a published icon replaces the type icon on the tab; a face replaces it with that avatar; the status mark still wins the slot", () => {
    const a = tab(1, { icon: { icon: "robot", tone: "accent", tooltip: "Agent on" } })
    const b = tab(2, { icon: { face: { id: "agent:ada", name: "Ada" }, pulse: true } })
    const { container } = mount()
    expect(inTab(container, a, "window-icon-robot")).toBeTruthy()
    expect(inTab(container, a, "type-icon")).toBeNull()
    expect(inTab(container, a, "window-icon-robot")?.getAttribute("title")).toBe("Agent on")
    expect(inTab(container, b, "window-icon-face")?.textContent).toBe("A")
    act(() => setWindowStatus(a, "needs-you"))
    expect(inTab(container, a, "window-status-needs-you")).toBeTruthy()
    expect(inTab(container, a, "window-icon-robot")).toBeNull()
  })

  it("[FLOAT-AC-22] marks sit after the title: at most two faces and a +n, or a glyph with its count", () => {
    const faces = ["Quinn QA", "Rex Dev", "Ada", "Iria"].map((name) => ({ id: name, name }))
    const a = tab(1, { marks: [{ id: "shared", icon: "users", label: "Shared", faces }] })
    const b = tab(2, { marks: [{ id: "watched", icon: "eye", label: "Watched", count: 3 }] })
    const c = tab(3, { marks: [{ id: "quiet", icon: "eye", label: "View only" }] })
    const { container } = mount()
    const pile = inTab(container, a, "window-mark-shared") as HTMLElement
    expect(pile.textContent).toBe("QQRD+2")
    expect(pile.getAttribute("aria-label")).toBe("Shared")
    expect(inTab(container, b, "window-mark-watched")?.textContent).toBe("3")
    expect(inTab(container, c, "window-mark-quiet")?.textContent).toBe("")
  })

  it("[FLOAT-AC-22] in a narrow tab the marks give way before the title: the title keeps a base width and shrinks last, the marks shrink first and clip", () => {
    const faces = ["Quinn QA", "Rex Dev"].map((name) => ({ id: name, name }))
    const a = tab(1, { marks: [{ id: "shared", icon: "users", label: "Shared", faces }] })
    const { container } = mount()
    const title = tabOf(container, a).querySelector("[data-tab-title]") as HTMLElement
    const marks = inTab(container, a, "window-marks") as HTMLElement
    expect(title.textContent).toBe("Tab 1")
    const titleStyle = getComputedStyle(title)
    const marksStyle = getComputedStyle(marks)
    expect(titleStyle.flexBasis).toBe(`${TAB_TITLE_KEEP}px`)
    expect(titleStyle.flexShrink).toBe("1")
    expect(marksStyle.flexShrink).toBe(String(TAB_MARKS_YIELD))
    expect(marksStyle.minWidth).toBe("0px")
    expect(marksStyle.overflowX).toBe("hidden")
    expect(TAB_MARKS_YIELD * 16).toBeGreaterThan(TAB_TITLE_KEEP * 100)
  })

  it("[FLOAT-AC-22] a strip with more tabs than fit always rests with a whole tab first, also at its end: the end is padded up to the next tab's start", () => {
    const starts = [0, 204, 408, 612, 816, 1020, 1224, 1428]
    const content = 1670
    expect(tabStripEndPad(starts, content, 2000)).toBe(0)
    expect(tabStripEndPad(starts, content, content)).toBe(0)
    const view = 950
    const pad = tabStripEndPad(starts, content, view)
    const end = content + pad - view
    expect(pad).toBeGreaterThan(0)
    expect(pad).toBeLessThan(204)
    expect(starts.map((at) => at - TAB_SNAP_LEAD)).toContain(end)
    for (const width of [300, 517, 640, 811, 1203, 1500]) {
      const rest = content + tabStripEndPad(starts, content, width) - width
      expect(starts.some((at) => Math.max(0, at - TAB_SNAP_LEAD) === rest)).toBe(true)
    }
    expect(tabStripEndPad([0], 400, 100)).toBe(0)
  })

  it("[FLOAT-AC-22] the pane carries a ring while its active window asks for one, and only then", () => {
    const a = tab(1, { ring: true })
    const b = tab(2)
    const { queryByTestId, container } = mount()
    expect(queryByTestId("window-ring")).toBeNull()
    fireEvent.click(tabOf(container, a))
    const ring = queryByTestId("window-ring") as HTMLElement
    expect(ring).toBeTruthy()
    expect(ring.style.pointerEvents).toBe("none")
    fireEvent.click(tabOf(container, b))
    expect(queryByTestId("window-ring")).toBeNull()
  })

  it("[FLOAT-AC-22] right-click on a tab opens the window's section: its name, its caption, its entries with shortcuts, then Close tab", () => {
    const onAgent = vi.fn()
    const a = tab(1, {
      menu: {
        caption: "Personal",
        entries: [
          { id: "agent", label: "Agent", trailing: "Off", shortcut: "⌘⇧K", onPress: onAgent },
          { id: "end", label: "End session", danger: true, separated: true, onPress: () => {} },
        ],
      },
    })
    const { container } = mount()
    fireEvent.contextMenu(tabOf(container, a), { clientX: 300, clientY: 20 })
    const menu = menuOf(a) as HTMLElement
    expect(menu.textContent).toContain("Tab 1")
    expect(menu.textContent).toContain("Personal")
    const row = menu.querySelector('[data-testid="window-menu-agent"]') as HTMLElement
    expect(row.textContent).toBe("AgentOff⌘⇧K")
    expect(menu.textContent?.indexOf("End session")).toBeLessThan(
      menu.textContent?.indexOf("Close tab") ?? -1,
    )
    fireEvent.click(row)
    expect(onAgent).toHaveBeenCalledTimes(1)
    expect(menuOf(a)).toBeNull()
  })

  it("[FLOAT-AC-22] a disabled entry says why and does nothing; Escape closes the menu; an entry always runs the window's latest handler", () => {
    const first = vi.fn()
    const second = vi.fn()
    const entry = (onPress: () => void) => ({ id: "go", label: "Go", onPress })
    const a = tab(1, {
      menu: {
        entries: [
          {
            id: "agent",
            label: "Agent",
            disabled: true,
            detail: "Quinn typed here in the last minute",
            onPress: first,
          },
          entry(first),
        ],
      },
    })
    const { container, rerender } = mount()
    fireEvent.contextMenu(tabOf(container, a), { clientX: 300, clientY: 20 })
    const row = menuOf(a)?.querySelector('[data-testid="window-menu-agent"]') as HTMLElement
    expect(row.textContent).toContain("Quinn typed here in the last minute")
    expect(row.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(row)
    expect(first).not.toHaveBeenCalled()
    expect(menuOf(a)).toBeTruthy()
    fireEvent.keyDown(document, { key: "Escape" })
    expect(menuOf(a)).toBeNull()
    published[1] = { menu: { entries: [entry(second)] } }
    rerender(<TilingLayout />)
    fireEvent.contextMenu(tabOf(container, a), { clientX: 300, clientY: 20 })
    fireEvent.click(menuOf(a)?.querySelector('[data-testid="window-menu-go"]') as HTMLElement)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("[FLOAT-AC-22] a title being edited is a field in the tab itself: Enter sends it trimmed, Escape cancels, and the tab is not dragged meanwhile", () => {
    const onDone = vi.fn()
    const a = tab(1, { titleEdit: { initial: "Shell 1", onDone } })
    const { container } = mount()
    const field = inTab(container, a, "window-title-input") as HTMLInputElement
    expect(field.value).toBe("Shell 1")
    expect(tabOf(container, a).getAttribute("draggable")).toBe("false")
    fireEvent.change(field, { target: { value: "  Deploy  " } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onDone).toHaveBeenCalledWith("Deploy")
    fireEvent.keyDown(field, { key: "Escape" })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it("[FLOAT-AC-22] Escape in the field cancels the edit", () => {
    const onDone = vi.fn()
    const a = tab(1, { titleEdit: { initial: "Shell 1", onDone } })
    const { container } = mount()
    fireEvent.keyDown(inTab(container, a, "window-title-input") as HTMLElement, { key: "Escape" })
    expect(onDone).toHaveBeenCalledWith(null)
  })

  it("[FLOAT-AC-22] what a window published goes away with the window", () => {
    const a = tab(1, { ring: true, marks: [{ id: "m", icon: "eye", label: "m" }] })
    mount()
    expect(useWindowChromeStore.getState().chrome[a]).toBeTruthy()
    act(() => s().closeWindow(a))
    expect(useWindowChromeStore.getState().chrome[a]).toBeUndefined()
  })
})

describe("the same chrome on a float", () => {
  const mountLayer = () =>
    render(<FloatingWindowLayer />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <TamaguiProvider config={config} defaultTheme="dark">
          {children}
        </TamaguiProvider>
      ),
    })

  it("[FLOAT-AC-22] a frame's header shows the published icon, marks and a menu button, and the frame carries the ring", () => {
    const a = tab(1, {
      icon: { icon: "robot", tone: "accent" },
      ring: true,
      marks: [{ id: "shared", icon: "users", label: "Shared" }],
      menu: { entries: [{ id: "agent", label: "Agent", onPress: () => {} }] },
    })
    tab(2)
    act(() => {
      s().floatWindow(a)
    })
    const { container } = mountLayer()
    const header = container.querySelector(`[data-float-header="${a}"]`) as HTMLElement
    expect(header.querySelector('[data-testid="window-icon-robot"]')).toBeTruthy()
    expect(header.querySelector('[data-testid="window-mark-shared"]')).toBeTruthy()
    expect(header.querySelector(`[data-testid="window-menu-button-${a}"]`)).toBeTruthy()
    expect(
      container.querySelector(`[data-float-window="${a}"] [data-testid="window-ring"]`),
    ).toBeTruthy()
  })

  it("[FLOAT-AC-22] a frame whose window publishes nothing has no menu button, no marks and no ring", () => {
    const a = tab(1)
    tab(2)
    act(() => {
      s().floatWindow(a)
    })
    const { container } = mountLayer()
    const host = container.querySelector(`[data-float-window="${a}"]`) as HTMLElement
    expect(host.querySelector('[data-testid^="window-menu-button-"]')).toBeNull()
    expect(host.querySelector('[data-testid="window-marks"]')).toBeNull()
    expect(host.querySelector('[data-testid="window-ring"]')).toBeNull()
  })
})
