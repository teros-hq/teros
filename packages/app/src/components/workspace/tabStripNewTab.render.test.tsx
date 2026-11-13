import { act, fireEvent, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { TamaguiProvider } from "tamagui"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"
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
vi.mock("expo-linear-gradient", () => ({
  LinearGradient: ({ style }: { style?: { left?: number; right?: number } }) => (
    <div data-testid={style?.right === 0 ? "strip-fade-right" : "strip-fade-left"} />
  ),
}))
vi.mock("../NewConversationModal", () => ({ NewConversationModal: () => null }))
vi.mock("./FrameMelt", () => ({ FrameMelt: () => null }))
vi.mock("./MobileTilingLayout", () => ({ MobileTilingLayout: () => null }))
vi.mock("../../contexts/VoiceSessionContext", () => ({
  useVoiceSession: () => ({ channelId: null, presence: "off" }),
}))

import { __resetResizeGuardForTest } from "../../lib/resizeGuard"
import { type WindowTypeDefinition, windowRegistry } from "../../services/windowRegistry"
import { useTilingStore } from "../../store/tilingStore"
import { TAB_FADE, TAB_SNAP_LEAD, tabStripReveal } from "./tabStrip"
import { TilingLayout } from "./TilingLayout"

const TYPE = "strip-probe"
const NEW_TAB = '[aria-label="Open launcher - new window"]'

const definitionOf = (type: string): WindowTypeDefinition => ({
  type,
  audience: "user",
  displayName: type,
  icon: (() => <span />) as unknown as WindowTypeDefinition["icon"],
  color: "#000000",
  noPreview: true,
  getTitle: (props) => (type === TYPE ? `Tab ${props.n}` : "New tab"),
  defaultSize: { width: 100, height: 100 },
  component: (() => (
    <div data-testid={`content-${type}`} />
  )) as unknown as WindowTypeDefinition["component"],
  serialize: (props) => props,
  deserialize: (data) => data,
})

const s = () => useTilingStore.getState()
const tab = (n: number) => s().openWindow(TYPE, { n }, { inNewTab: true })!

function mount() {
  return render(<TilingLayout />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <TamaguiProvider config={config} defaultTheme="dark">
        {children}
      </TamaguiProvider>
    ),
  })
}

const q = (c: HTMLElement, selector: string) => c.querySelector(selector) as HTMLElement
const scrollArea = (c: HTMLElement) => q(c, '[data-testid="tab-strip-scroll"]')
const comesBefore = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

function overflowBy(c: HTMLElement, hidden: number) {
  const scroller = scrollArea(c).firstElementChild as HTMLElement
  Object.defineProperty(scroller, "clientWidth", { value: 600, configurable: true })
  Object.defineProperty(scroller, "scrollWidth", { value: 600 + hidden, configurable: true })
  return scroller
}

let registeredLauncher = false

beforeEach(() => {
  __resetResizeGuardForTest()
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 1280,
    configurable: true,
  })
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 800,
    configurable: true,
  })
  window.dispatchEvent(new Event("resize"))
  windowRegistry.register(definitionOf(TYPE))
  registeredLauncher = !windowRegistry.get("launcher")
  if (registeredLauncher) windowRegistry.register(definitionOf("launcher"))
  useTilingStore.setState({ windows: {}, nextId: 1, activeDesktopIndex: 0 })
  s().resetDesktops()
  s().setCompactShell(false)
})
afterEach(() => {
  windowRegistry.unregister(TYPE)
  if (registeredLauncher) windowRegistry.unregister("launcher")
})

describe("the tab strip's new-tab button is always in view", () => {
  it("[TW-AC-25] while the tabs fit, the + follows the last tab: the scroll area is only as wide as its tabs and the free room comes after the +", () => {
    const a = tab(1)
    const b = tab(2)
    const { container } = mount()
    const area = scrollArea(container)
    const plus = q(container, NEW_TAB)
    const rest = q(container, '[data-testid="tab-strip-rest"]')
    const areaStyle = getComputedStyle(area)
    expect(areaStyle.flexGrow).toBe("0")
    expect(areaStyle.flexShrink).toBe("1")
    expect(areaStyle.minWidth).toBe("0px")
    expect(area.nextElementSibling).toBe(plus)
    expect(plus.nextElementSibling).toBe(rest)
    expect(getComputedStyle(rest).flexGrow).toBe("1")
    expect(getComputedStyle(plus).flexShrink).toBe("0")
    expect(getComputedStyle(plus).width).toBe("30px")
    expect(getComputedStyle(plus).height).toBe("30px")
    expect(area.querySelector('[data-testid="strip-fade-right"]')).toBeNull()
    const tabs = Array.from(container.querySelectorAll("[data-tab]"))
    expect(tabs.map((el) => el.getAttribute("data-window-id"))).toEqual([a, b])
    expect(tabs.every((el) => area.contains(el))).toBe(true)
  })

  it("[TW-AC-25] with more tabs than fit, the + is pinned outside the scroll area, which ends before it with the strip's fade; it still opens the launcher", () => {
    tab(1)
    const { container } = mount()
    overflowBy(container, 900)
    act(() => {
      for (let n = 2; n <= 12; n++) tab(n)
    })
    const area = scrollArea(container)
    const plus = q(container, NEW_TAB)
    const fade = area.querySelector('[data-testid="strip-fade-right"]') as HTMLElement
    expect(fade).not.toBeNull()
    expect(area.contains(plus)).toBe(false)
    expect(area.nextElementSibling).toBe(plus)
    expect(comesBefore(fade, plus)).toBe(true)
    const tabs = Array.from(container.querySelectorAll("[data-tab]"))
    expect(tabs).toHaveLength(12)
    expect(tabs.every((el) => area.contains(el) && comesBefore(el, plus))).toBe(true)
    expect(comesBefore(plus, q(container, '[aria-label="Window options menu"]'))).toBe(true)
    fireEvent.click(plus)
    const opened = Object.values(s().windows).filter((w) => w.type === "launcher")
    expect(opened).toHaveLength(1)
    expect(container.querySelectorAll("[data-tab]")).toHaveLength(13)
    expect(area.contains(q(container, NEW_TAB))).toBe(false)
  })

  it("[TW-AC-25] the fade before the pinned + goes away at the strip's end, so it never covers the last tab's close button", () => {
    tab(1)
    const { container } = mount()
    const scroller = overflowBy(container, 900)
    act(() => {
      tab(2)
    })
    expect(scrollArea(container).querySelector('[data-testid="strip-fade-right"]')).not.toBeNull()
    Object.defineProperty(scroller, "scrollLeft", { value: 900, configurable: true })
    act(() => {
      tab(3)
    })
    expect(scrollArea(container).querySelector('[data-testid="strip-fade-right"]')).toBeNull()
    expect(scrollArea(container).contains(q(container, NEW_TAB))).toBe(false)
  })

  it("[TW-AC-25] the strip's rest position for a tab shows it whole and clear of the fade: null when it already is, the tab's own start when it is to the left, the earliest tab start that fits it when it is to the right", () => {
    const starts = [0, 204, 408, 612, 816, 1020, 1224, 1428]
    const view = 600
    expect(tabStripReveal(starts, 204, 404, view, 0)).toBeNull()
    expect(tabStripReveal(starts, 408, 608, view, 0)).toBe(204 - TAB_SNAP_LEAD)
    expect(tabStripReveal(starts, 1428, 1628, view, 0)).toBe(1224 - TAB_SNAP_LEAD)
    expect(tabStripReveal(starts, 204, 404, view, 1204)).toBe(204 - TAB_SNAP_LEAD)
    expect(tabStripReveal(starts, 0, 200, view, 388)).toBe(0)
    expect(tabStripReveal(starts, 1428, 1628, 150, 0)).toBe(1428 - TAB_SNAP_LEAD)
    for (let index = 0; index < starts.length; index++) {
      for (const from of [0, 184, 592, 1204, 1408]) {
        const end = starts[index] + 200
        const at = tabStripReveal(starts, starts[index], end, view, from) ?? from
        expect(starts[index]).toBeGreaterThanOrEqual(at)
        expect(end + TAB_FADE).toBeLessThanOrEqual(at + view)
      }
    }
  })
})

describe("the last tab's close button next to the new-tab button", () => {
  const TAB = 200
  const GAP = 4
  const VIEW = 600
  let scrollLeft = 0
  let moved: Mock<(to: number) => void>

  const tabsOf = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("[data-tab]"))
  const closeOf = (el: HTMLElement) => el.querySelector('[aria-label="Close tab"]') as HTMLElement

  function layOut(c: HTMLElement) {
    const scroller = scrollArea(c).firstElementChild as HTMLElement
    const content = scroller.firstElementChild as HTMLElement
    const width = () => {
      const count = tabsOf(c).length
      return count * TAB + (count - 1) * GAP + parseFloat(getComputedStyle(content).paddingRight)
    }
    moved = vi.fn((to: number) => {
      scrollLeft = Math.max(0, Math.min(to, width() - VIEW))
    })
    Object.defineProperty(scroller, "clientWidth", {
      get: () => Math.min(VIEW, width()),
      configurable: true,
    })
    Object.defineProperty(scroller, "scrollWidth", { get: width, configurable: true })
    Object.defineProperty(scroller, "scrollLeft", {
      get: () => scrollLeft,
      set: moved,
      configurable: true,
    })
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const index = this.hasAttribute("data-tab") ? tabsOf(c).indexOf(this) : -1
      const left = index < 0 ? 0 : index * (TAB + GAP) - scrollLeft
      const size = index < 0 ? 0 : TAB
      return {
        left,
        right: left + size,
        x: left,
        y: 0,
        top: 0,
        bottom: 30,
        width: size,
        height: 30,
      } as DOMRect
    })
    return scroller
  }
  const inView = (c: HTMLElement, el: HTMLElement) => {
    const rect = el.getBoundingClientRect()
    const scroller = scrollArea(c).firstElementChild as HTMLElement
    return rect.left >= 0 && rect.right + TAB_FADE <= scroller.clientWidth
  }

  beforeEach(() => {
    scrollLeft = 0
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("[TW-AC-25] while the tabs fit, the active last tab keeps its close button inside the strip before the +, the strip does not move, and the button closes the tab", () => {
    tab(1)
    const { container } = mount()
    layOut(container)
    let last = ""
    act(() => {
      last = tab(2)
    })
    const tabs = tabsOf(container)
    const close = closeOf(tabs[tabs.length - 1])
    expect(tabs[tabs.length - 1].getAttribute("data-window-id")).toBe(last)
    expect(close).not.toBeNull()
    expect(scrollArea(container).contains(close)).toBe(true)
    expect(comesBefore(close, q(container, NEW_TAB))).toBe(true)
    expect(moved).not.toHaveBeenCalled()
    fireEvent.click(close)
    expect(s().windows[last]).toBeUndefined()
    expect(tabsOf(container)).toHaveLength(1)
  })

  it("[TW-AC-25] with more tabs than fit, opening a tab from the pinned + brings it whole into the strip, its close button clear of the fade and of the +, and the button closes it", () => {
    tab(1)
    const { container } = mount()
    layOut(container)
    act(() => {
      for (let n = 2; n <= 7; n++) tab(n)
    })
    act(() => {
      fireEvent.click(q(container, NEW_TAB))
    })
    const tabs = tabsOf(container)
    expect(tabs).toHaveLength(8)
    const last = tabs[tabs.length - 1]
    const opened = Object.values(s().windows).find((w) => w.type === "launcher")!
    expect(last.getAttribute("data-window-id")).toBe(opened.id)
    expect(moved).toHaveBeenLastCalledWith(1224 - TAB_SNAP_LEAD)
    expect(scrollLeft).toBe(1224 - TAB_SNAP_LEAD)
    expect(inView(container, last)).toBe(true)
    const close = closeOf(last)
    expect(scrollArea(container).contains(close)).toBe(true)
    expect(scrollArea(container).contains(q(container, NEW_TAB))).toBe(false)
    fireEvent.click(close)
    expect(s().windows[opened.id]).toBeUndefined()
    expect(tabsOf(container)).toHaveLength(7)
  })

  it("[TW-AC-25] choosing a tab that is out of view brings it whole into the strip too", () => {
    const first = tab(1)
    const { container } = mount()
    layOut(container)
    act(() => {
      for (let n = 2; n <= 8; n++) tab(n)
    })
    expect(inView(container, tabsOf(container)[7])).toBe(true)
    act(() => {
      s().focusWindow(first)
    })
    expect(scrollLeft).toBe(0)
    expect(inView(container, tabsOf(container)[0])).toBe(true)
  })
})
