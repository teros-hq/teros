import { act, createEvent, fireEvent, render } from "@testing-library/react"
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
vi.mock("../../contexts/VoiceSessionContext", () => ({
  useVoiceSession: () => ({ channelId: null, presence: "off" }),
}))

import { __resetResizeGuardForTest } from "../../lib/resizeGuard"
import { type WindowTypeDefinition, windowRegistry } from "../../services/windowRegistry"
import { useTilingStore } from "../../store/tilingStore"
import { setWindowStatus, useWindowTabMetaStore } from "../../store/windowTabMetaStore"
import { launcherWindowDefinition } from "../../windows/LauncherWindow/definition"
import { TilingLayout } from "./TilingLayout"

const TYPE = "__pane_probe__"
const FIXED = "__pane_fixed__"

function def(type: string, extra: Partial<WindowTypeDefinition> = {}): WindowTypeDefinition {
  return {
    type,
    audience: "user",
    displayName: type,
    icon: (() => <span data-testid={`icon-${type}`} />) as unknown as WindowTypeDefinition["icon"],
    color: "#000000",
    noPreview: true,
    getTitle: (props) => `Tab ${props.n}`,
    defaultSize: { width: 100, height: 100 },
    component: (({ windowId }: { windowId: string }) => (
      <div data-testid={`content-${windowId}`} />
    )) as unknown as WindowTypeDefinition["component"],
    serialize: (props) => props,
    deserialize: (data) => data,
    ...extra,
  }
}

const s = () => useTilingStore.getState()
const tab = (n: number, type = TYPE) => s().openWindow(type, { n }, { inNewTab: true })!

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

beforeEach(() => {
  __resetResizeGuardForTest()
  Object.defineProperty(document.documentElement, "clientWidth", { value: 1280, configurable: true })
  Object.defineProperty(document.documentElement, "clientHeight", { value: 800, configurable: true })
  window.dispatchEvent(new Event("resize"))
  windowRegistry.register(def(TYPE))
  windowRegistry.register(def(FIXED, { capabilities: { canFloat: false } }))
  useTilingStore.setState({ windows: {}, floats: {}, nextId: 1, activeDesktopIndex: 0 })
  useWindowTabMetaStore.setState({ meta: {}, status: {} })
  s().resetDesktops()
  s().setCompactShell(false)
})
afterEach(() => {
  windowRegistry.unregister(TYPE)
  windowRegistry.unregister(FIXED)
})

describe("floating from a pane", () => {
  it("[FLOAT-AC-14] the tab strip has a control that floats the pane's active tab", () => {
    const a = tab(1)
    const b = tab(2)
    const { getByTestId, container } = mount()
    fireEvent.click(getByTestId("pane-float"))
    expect(s().floats[b]).toBeDefined()
    expect(s().floats[a]).toBeUndefined()
    expect(tabOf(container, b)).toBeNull()
    expect(tabOf(container, a)).toBeTruthy()
  })

  it("[FLOAT-AC-14] the control is not offered for a window type that does not float", () => {
    tab(1)
    const { queryByTestId } = mount()
    expect(queryByTestId("pane-float")).toBeTruthy()
    act(() => {
      tab(2, FIXED)
    })
    expect(queryByTestId("pane-float")).toBeNull()
  })

  it("[FLOAT-AC-1] the launcher is the one built-in window that does not float", () => {
    expect(launcherWindowDefinition.capabilities?.canFloat).toBe(false)
  })

  it("[FLOAT-AC-14] dropping a tab on the middle of its own pane floats it where it was dropped", () => {
    const a = tab(1)
    const b = tab(2)
    const { container } = mount()
    const pane = container.querySelector("[data-pane]") as HTMLElement
    pane.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 }) as DOMRect
    const dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" }
    const at = (event: Event) => {
      Object.defineProperty(event, "clientX", { value: 640 })
      Object.defineProperty(event, "clientY", { value: 400 })
      return event
    }
    fireEvent.dragStart(tabOf(container, a), { dataTransfer })
    expect(document.body.classList.contains("teros-resizing")).toBe(true)
    fireEvent(pane, at(createEvent.dragOver(pane, { dataTransfer })))
    expect(container.querySelector('[data-testid="pane-drop-float"]')).toBeTruthy()
    fireEvent(pane, at(createEvent.drop(pane, { dataTransfer })))
    fireEvent.dragEnd(tabOf(container, b), { dataTransfer })
    expect(document.body.classList.contains("teros-resizing")).toBe(false)
    expect(s().floats[a]).toBeDefined()
    expect(s().floats[b]).toBeUndefined()
    expect(s().floats[a].x + s().floats[a].w / 2).toBe(640)
  })

  it("[FLOAT-AC-14] a drag that is cancelled over the pane's middle floats nothing", () => {
    const a = tab(1)
    tab(2)
    const { container } = mount()
    const pane = container.querySelector("[data-pane]") as HTMLElement
    pane.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 }) as DOMRect
    const dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "", dropEffect: "none" }
    const at = (event: Event) => {
      Object.defineProperty(event, "clientX", { value: 640 })
      Object.defineProperty(event, "clientY", { value: 400 })
      return event
    }
    fireEvent.dragStart(tabOf(container, a), { dataTransfer })
    fireEvent(pane, at(createEvent.dragOver(pane, { dataTransfer })))
    expect(container.querySelector('[data-testid="pane-drop-float"]')).toBeTruthy()
    fireEvent.dragEnd(tabOf(container, a), { dataTransfer })
    expect(s().floats).toEqual({})
    expect(container.querySelector('[data-testid="pane-drop-float"]')).toBeNull()
    expect(document.body.classList.contains("teros-resizing")).toBe(false)
  })

  it("[FLOAT-AC-14] a drag that never reports its end still lets go of the embedded pages on the next press", () => {
    const a = tab(1)
    tab(2)
    const { container, unmount } = mount()
    const dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" }
    fireEvent.dragStart(tabOf(container, a), { dataTransfer })
    expect(document.body.classList.contains("teros-resizing")).toBe(true)
    act(() => {
      window.dispatchEvent(new Event("pointerdown"))
    })
    expect(document.body.classList.contains("teros-resizing")).toBe(false)
    fireEvent.dragStart(tabOf(container, a), { dataTransfer })
    expect(document.body.classList.contains("teros-resizing")).toBe(true)
    unmount()
    expect(document.body.classList.contains("teros-resizing")).toBe(false)
  })

  it("[FLOAT-AC-15] a tab draws the status its window publishes", () => {
    const a = tab(1)
    const b = tab(2)
    const { container } = mount()
    expect(tabOf(container, a).querySelector(`[data-testid="icon-${TYPE}"]`)).toBeTruthy()
    act(() => {
      setWindowStatus(a, "needs-you")
      setWindowStatus(b, "working")
    })
    expect(tabOf(container, a).querySelector('[data-testid="window-status-needs-you"]')).toBeTruthy()
    expect(tabOf(container, b).querySelector('[data-testid="window-status-working"]')).toBeTruthy()
    act(() => {
      setWindowStatus(a, "finished")
    })
    expect(tabOf(container, a).querySelector('[data-testid="window-status-finished"]')).toBeTruthy()
  })
})
